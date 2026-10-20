import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { assetsApi } from '@/lib/api'
import { qk } from '@/lib/api/keys'
import { UploadQueue } from './uploadQueue'

export function useUploadQueue(maxBytes: number) {
  const client = useQueryClient()
  const [queue] = useState(
    () =>
      new UploadQueue({
        maxBytes,
        uploader: (file, { signal, onProgress }) => assetsApi.upload(file, { signal, onProgress }),
        onUploaded: () => {
          void client.invalidateQueries({ queryKey: qk.assets.all })
        },
      }),
  )
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  useEffect(() => () => queue.dispose(), [queue])
  return { queue, items }
}
