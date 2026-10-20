/** The language a PDF declares for its text: the page's `lang` when it is a valid BCP 47 tag, else English. */
export function documentLanguage(): string {
  const lang = typeof document === 'undefined' ? '' : document.documentElement.lang
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(lang) ? lang : 'en'
}
