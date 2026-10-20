import { localRepository } from './repository'

export { LocalRepository, localRepository, openBrowserStore } from './repository'
export type { NewLocalAssetInput, SaveLocalDesignInput } from './repository'
export { createIndexedDbStore, createMemoryStore, mapStorageError, openDatabase } from './store'
export type { LocalStore } from './store'
export { LocalStorageError, LocalStorageFullError } from './types'
export type { LocalAsset, LocalDesign, LocalDesignSummary, StorageMode, StorageUsage } from './types'

export const listLocalDesigns = () => localRepository.listDesigns()
export const getLocalDesign = (id: string) => localRepository.getDesign(id)
export const createLocalDesign = (input: Parameters<typeof localRepository.createDesign>[0]) => localRepository.createDesign(input)
export const saveLocalDesign = (input: Parameters<typeof localRepository.saveDesign>[0]) => localRepository.saveDesign(input)
export const deleteLocalDesign = (id: string) => localRepository.deleteDesign(id)
export const putLocalAsset = (input: Parameters<typeof localRepository.putAsset>[0]) => localRepository.putAsset(input)
export const getLocalAsset = (id: string) => localRepository.getAsset(id)
export const listLocalAssets = () => localRepository.listAssets()
export const deleteLocalAsset = (id: string) => localRepository.deleteAsset(id)
export const getAssetObjectUrl = (id: string) => localRepository.getAssetObjectUrl(id)
export const estimateUsage = () => localRepository.estimateUsage()
