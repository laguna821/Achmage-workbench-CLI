param([ValidateSet('setup', 'v8', 'browser', 'package')][string]$Stage)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repo = Split-Path $PSScriptRoot -Parent
$source = Join-Path $repo 'native-source'
$evidence = Join-Path $repo 'native-evidence'
$cache = Join-Path $repo 'native-cache'
$spec = Get-Content "$repo/third_party/lightpanda-windows/source.json" -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force $evidence, $cache | Out-Null

function Check-Exit([string]$message) {
    if ($LASTEXITCODE -ne 0) { throw "$message (exit $LASTEXITCODE)" }
}
function Set-BuildEnv([string]$name, [string]$value) {
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    "$name=$value" | Out-File $env:GITHUB_ENV -Append -Encoding utf8
}

if ($Stage -eq 'setup') {
    # Zig cannot invoke the runner's Strawberry Perl pkg-config.BAT shim.
    # Standard Windows system libraries need no pkg-config metadata.
    $buildPath = ($env:PATH -split ';' | Where-Object { $_ -notmatch '(?i)[\\/]Strawberry[\\/]perl[\\/]bin[\\/]?$' }) -join ';'
    Set-BuildEnv 'PATH' $buildPath
    $tools = Get-Content "$repo/third_party/lightpanda-windows/tools.json" -Raw | ConvertFrom-Json
    $toolRoot = Join-Path $env:RUNNER_TEMP 'lightpanda-tools'
    $depot = Join-Path $source "v8/.lp-cache/depot_tools-$($spec.v8Version)"
    New-Item -ItemType Directory -Force $toolRoot, $depot | Out-Null
    foreach ($name in @('zig', 'gn', 'ninja')) {
        $inputSpec = $tools.$name
        $zip = Join-Path $toolRoot "$name.zip"
        Invoke-WebRequest $inputSpec.url -OutFile $zip
        if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $inputSpec.sha256) { throw "$name SHA256 mismatch" }
        Expand-Archive $zip -DestinationPath "$toolRoot/$name"
        $exe = @(Get-ChildItem "$toolRoot/$name" -Recurse -File -Filter "$name.exe")
        if ($exe.Count -ne 1) { throw "Expected one $name.exe" }
        if ($name -eq 'zig') { $exe[0].DirectoryName | Out-File $env:GITHUB_PATH -Append -Encoding utf8 }
        else { Copy-Item $exe[0].FullName $depot }
    }
    $vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
    $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    Check-Exit 'vswhere failed'
    if (!$vs) { throw 'MSVC installation missing' }
    $msvc = Get-ChildItem "$vs/VC/Tools/MSVC" -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    $sdk = "${env:ProgramFiles(x86)}/Windows Kits/10/Lib/10.0.26100.0"
    if (!(Test-Path "$sdk/um/x64/kernel32.lib")) { throw 'Required Windows SDK 10.0.26100.0 missing' }
    Set-BuildEnv 'vs2022_install' $vs
    Set-BuildEnv 'GYP_MSVS_VERSION' '2022'
    Set-BuildEnv 'DEPOT_TOOLS_UPDATE' '0'
    Set-BuildEnv 'DEPOT_TOOLS_WIN_TOOLCHAIN' '0'
    Set-BuildEnv 'LP_MSVC_LIB_X64' "$($msvc.FullName)/lib/x64"
    Set-BuildEnv 'LP_WINSDK_DIR' $sdk
    Set-BuildEnv 'LP_FILTERED_LIBS' "$source/browser/win-port/filtered-libs"
    # Start with the installed, unmodified CRT. Any required removals must be
    # justified by actual linker output; never import the PR's opaque binary.
    New-Item $env:LP_FILTERED_LIBS -ItemType Directory -Force | Out-Null
    Copy-Item "$env:LP_MSVC_LIB_X64/msvcrt.lib" $env:LP_FILTERED_LIBS
    "C:/Program Files/Git/usr/bin" | Out-File $env:GITHUB_PATH -Append -Encoding utf8
    "$($msvc.FullName)/bin/Hostx64/x64" | Out-File $env:GITHUB_PATH -Append -Encoding utf8
    # GN invokes python3.exe. Use the same setup-python interpreter, not the Store stub.
    $python = (Get-Command python).Source
    $python3 = Join-Path (Split-Path $python) 'python3.exe'
    if (!(Test-Path $python3)) { Copy-Item $python $python3 }
    & rustup target add x86_64-pc-windows-gnu
    Check-Exit 'Rust Windows GNU target installation failed'
    @{
        os=[Environment]::OSVersion.VersionString; msvc=$msvc.Name; visualStudio=$vs;
        sdk=$sdk; rust=(& rustc --version); python=(& python --version);
        msvcrtSha256=(Get-FileHash "$env:LP_FILTERED_LIBS/msvcrt.lib" -Algorithm SHA256).Hash;
        tools=$tools; repositoryRevision=$env:GITHUB_SHA; run=$env:GITHUB_RUN_ID
    } | ConvertTo-Json -Depth 10 | Set-Content "$evidence/environment.json"
}
elseif ($Stage -eq 'v8') {
    if (Test-Path "$cache/c_v8.lib") {
        $proof = Get-Content "$cache/provenance.json" -Raw | ConvertFrom-Json
        if ((Get-FileHash "$cache/c_v8.lib" -Algorithm SHA256).Hash -ne $proof.sha256) { throw 'Cached V8 SHA256 mismatch' }
        Write-Output "Using cached V8 $($proof.sha256)"
        exit 0
    }
    Push-Location "$source/v8"
    try {
        & zig build build-v8 -Doptimize=ReleaseFast -Dcpu=x86_64 --summary all 2>&1 | Tee-Object "$evidence/v8-build.log"
        Check-Exit 'V8 source build failed'
        $libs = @(Get-ChildItem '.lp-cache' -Recurse -File -Filter 'c_v8.lib')
        if ($libs.Count -ne 1) { throw 'Expected one compiled c_v8.lib' }
        Copy-Item $libs[0].FullName "$cache/c_v8.lib"
        @{
            sha256=(Get-FileHash "$cache/c_v8.lib" -Algorithm SHA256).Hash;
            source=$spec.sources.v8; v8Version=$spec.v8Version;
            environment=(Get-Content "$evidence/environment.json" -Raw | ConvertFrom-Json)
        } | ConvertTo-Json -Depth 12 | Set-Content "$cache/provenance.json"
    } finally { Pop-Location }
}
elseif ($Stage -eq 'browser') {
    Push-Location "$source/browser"
    try {
        # Upstream's Windows ZIP fetch workaround; Zig still validates its declared package hash.
        Invoke-WebRequest 'https://sqlite.org/2026/sqlite-amalgamation-3530200.zip' -OutFile "$env:RUNNER_TEMP/sqlite.zip"
        Expand-Archive "$env:RUNNER_TEMP/sqlite.zip" "$env:RUNNER_TEMP/sqlite"
        $sqlite = Get-ChildItem "$env:RUNNER_TEMP/sqlite" -Directory | Select-Object -First 1
        & zig fetch $sqlite.FullName
        Check-Exit 'SQLite prefetch failed'
        & zig build -Doptimize=ReleaseFast -Dcpu=x86_64 "-Dversion=$($spec.engineVersion)" "-Dprebuilt_v8_path=$cache/c_v8.lib" --summary all 2>&1 | Tee-Object "$evidence/browser-build.log"
        Check-Exit 'Browser source build failed'
        & dumpbin /dependents zig-out/bin/lightpanda.exe | Set-Content "$evidence/dependencies.txt"
        Check-Exit 'PE dependency inspection failed'
    } finally { Pop-Location }
}
elseif ($Stage -eq 'package') {
    $package = Join-Path $repo 'native-package'
    New-Item $package -ItemType Directory -Force | Out-Null
    Copy-Item "$source/browser/zig-out/bin/lightpanda.exe" $package
    Copy-Item "$source/browser/LICENSE", "$source/source-provenance.json" $package
    Copy-Item "$source/v8/LICENSE" "$package/V8-BINDING-LICENSE"
    Copy-Item "$cache/provenance.json" "$package/v8-provenance.json"
    $redist = Get-ChildItem "$env:vs2022_install/VC/Redist/MSVC" -Directory | Where-Object Name -Match '^\d+\.' | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    $crt = @(Get-ChildItem "$($redist.FullName)/x64" -Directory -Filter 'Microsoft.VC*.CRT')
    if ($crt.Count -ne 1) { throw 'MSVC redistributable directory ambiguous or missing' }
    Copy-Item "$($crt[0].FullName)/*.dll" $package
    $version = (& "$package/lightpanda.exe" version) -join "`n"
    Check-Exit 'Packaged native executable failed'
    if ($version.Trim() -ne $spec.engineVersion) { throw "Unexpected version $version" }
    $hashes = Get-ChildItem $package -File | ForEach-Object { @{name=$_.Name;bytes=$_.Length;sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} }
    $hashes | ConvertTo-Json | Set-Content "$package/files.json"
    Compress-Archive "$package/*" "$repo/lightpanda-windows-x64.zip"
    Get-FileHash "$repo/lightpanda-windows-x64.zip" -Algorithm SHA256 | Format-List
}
