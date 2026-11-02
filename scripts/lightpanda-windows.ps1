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
    # Native link run 41410510469 identified two CFG globals supplied by both
    # MinGW and this MSVC member. Derive a copy from the installed SDK and remove
    # only that member; preserve the original SDK and all TLS support members.
    New-Item $env:LP_FILTERED_LIBS -ItemType Directory -Force | Out-Null
    $originalCrt = "$env:LP_MSVC_LIB_X64/msvcrt.lib"
    $librarian = "$($msvc.FullName)/bin/Hostx64/x64/lib.exe"
    $members = @(& $librarian /nologo /list $originalCrt | ForEach-Object { $_.Trim() })
    Check-Exit 'MSVC archive inventory failed'
    $duplicate = @($members | Where-Object { $_ -match '(^|[\\/])guard_support\.obj$' })
    if ($duplicate.Count -ne 1) { throw 'Expected exactly one MSVC guard_support.obj' }
    & $librarian /nologo "/remove:$($duplicate[0])" "/out:$env:LP_FILTERED_LIBS/msvcrt.lib" $originalCrt
    Check-Exit 'MSVC duplicate CFG member removal failed'
    $retained = @(& $librarian /nologo /list "$env:LP_FILTERED_LIBS/msvcrt.lib" | ForEach-Object { $_.Trim() })
    Check-Exit 'Derived MSVC archive inventory failed'
    $expected = @($members | Where-Object { $_ -ne $duplicate[0] })
    if (@(Compare-Object $expected $retained).Count -ne 0) { throw 'Derived MSVC archive changed unexpected members' }
    @{
        originalSha256=(Get-FileHash $originalCrt -Algorithm SHA256).Hash;
        derivedSha256=(Get-FileHash "$env:LP_FILTERED_LIBS/msvcrt.lib" -Algorithm SHA256).Hash;
        removed=$duplicate; originalMembers=$members.Count; retainedMembers=$retained.Count;
        reason='Duplicate CFG globals already defined by MinGW; native link run 41410510469';
        tool=$librarian
    } | ConvertTo-Json -Depth 5 | Set-Content "$evidence/crt-derivation.json"
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
    Copy-Item "$repo/third_party/lightpanda-windows/V8-ENGINE-LICENSE" $package
    Copy-Item "$cache/provenance.json" "$package/v8-provenance.json"
    Copy-Item "$evidence/crt-derivation.json" $package
    @"
Achmage Workbench native Windows Lightpanda $($spec.engineVersion)

This is an independently built Windows port, not an official Lightpanda Windows release.
Source revisions and patch hashes: source-provenance.json
Source patches and build instructions:
https://github.com/laguna821/Achmage-workbench-CLI/tree/$env:GITHUB_SHA/third_party/lightpanda-windows
Build workflow and scripts:
https://github.com/laguna821/Achmage-workbench-CLI/tree/$env:GITHUB_SHA/scripts
Original browser: https://github.com/lightpanda-io/browser
V8 binding: https://github.com/lightpanda-io/zig-v8-fork
V8 engine source: https://chromium.googlesource.com/v8/v8/+/refs/tags/$($spec.v8Version)

Browser license: LICENSE (AGPL-3.0-or-later)
V8 binding license: V8-BINDING-LICENSE (MIT)
V8 engine license: V8-ENGINE-LICENSE (BSD and upstream notices)
Microsoft Visual C++ runtime DLLs are included for application-local execution.
Workbench uses MCP over stdio, with one engine process per session.
"@ | Set-Content "$package/README-WINDOWS.txt"
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
