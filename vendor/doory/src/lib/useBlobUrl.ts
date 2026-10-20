import { useEffect, useState } from 'react'

/** An object URL for a Blob that is revoked when the Blob changes or the component unmounts. */
export function useBlobUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) return undefined
    const created = URL.createObjectURL(blob)
    // Object URLs are an external, revocable resource: they can only be created inside an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(created)
    return () => {
      URL.revokeObjectURL(created)
      setUrl(null)
    }
  }, [blob])
  return blob ? url : null
}
