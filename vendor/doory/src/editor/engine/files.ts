/** Opens the system file picker; resolves with the chosen files, or `[]` when the dialog is cancelled. */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    let settled = false
    const finish = (files: File[]): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => finish([...(input.files ?? [])]))
    input.addEventListener('cancel', () => finish([]))
    document.body.appendChild(input)
    input.click()
  })
}

/** Image files out of a drop/paste `DataTransfer`. */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return []
  return [...data.files].filter((f) => f.type.startsWith('image/'))
}
