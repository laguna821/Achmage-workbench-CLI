/** Native paths stay in the trusted parent. Browser files cross as bytes. */
export async function pickOfficeFiles(): Promise<{ paths: string[] } | { files: File[] } | null> {
  if ("__TAURI_INTERNALS__" in window) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ title: "참고 파일 첨부", multiple: true, directory: false });
    return picked ? { paths: Array.isArray(picked) ? picked : [picked] } : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement("input"); input.type = "file"; input.multiple = true;
    input.onchange = () => resolve(input.files?.length ? { files: [...input.files] } : null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
