import { useEffect } from 'react'

export interface PageMeta {
  /** "<title> · Doory". */
  title?: string | null
  description?: string
  /** An absolute URL, or a path that is resolved against this site's origin. */
  canonical?: string
  /** The preview image for link cards (absolute URL or path). */
  image?: string
  /** Keeps the page out of search results (account pages, the editor, auth forms). */
  noindex?: boolean
}

type Selector = { tag: 'meta'; attr: 'name' | 'property'; key: string } | { tag: 'link'; attr: 'rel'; key: string }

/** Sets one head tag and returns what puts it back: the old value, or removal when the tag did not exist. */
function setTag(selector: Selector, value: string): () => void {
  const attribute = selector.tag === 'link' ? 'href' : 'content'
  let element = document.head.querySelector<HTMLElement>(`${selector.tag}[${selector.attr}="${selector.key}"]`)
  const created = element === null
  if (!element) {
    element = document.createElement(selector.tag)
    element.setAttribute(selector.attr, selector.key)
    document.head.appendChild(element)
  }
  const previous = element.getAttribute(attribute)
  element.setAttribute(attribute, value)
  return () => {
    if (created) element?.remove()
    else if (previous === null) element?.removeAttribute(attribute)
    else element?.setAttribute(attribute, previous)
  }
}

const absolute = (value: string): string => new URL(value, window.location.origin).toString()

/**
 * Title, description, canonical address, link-card tags (Open Graph and Twitter) and robots hint of the current page, put back
 * to what they were when the page goes away. A client-rendered app can only do this for crawlers that run scripts, which the
 * big ones do; the static tags in `index.html` stay the fallback for everything else.
 */
export function usePageMeta({ title, description, canonical, image, noindex }: PageMeta): void {
  useEffect(() => {
    const undo: Array<() => void> = []
    const previousTitle = document.title
    if (title) document.title = `${title} · Doory`
    const shownTitle = title ? `${title} · Doory` : null
    if (description) {
      undo.push(setTag({ tag: 'meta', attr: 'name', key: 'description' }, description))
      undo.push(setTag({ tag: 'meta', attr: 'property', key: 'og:description' }, description))
      undo.push(setTag({ tag: 'meta', attr: 'name', key: 'twitter:description' }, description))
    }
    if (shownTitle) {
      undo.push(setTag({ tag: 'meta', attr: 'property', key: 'og:title' }, shownTitle))
      undo.push(setTag({ tag: 'meta', attr: 'name', key: 'twitter:title' }, shownTitle))
    }
    if (canonical) {
      const url = absolute(canonical)
      undo.push(setTag({ tag: 'link', attr: 'rel', key: 'canonical' }, url))
      undo.push(setTag({ tag: 'meta', attr: 'property', key: 'og:url' }, url))
    }
    if (image) {
      const url = absolute(image)
      undo.push(setTag({ tag: 'meta', attr: 'property', key: 'og:image' }, url))
      undo.push(setTag({ tag: 'meta', attr: 'name', key: 'twitter:image' }, url))
    }
    if (noindex) undo.push(setTag({ tag: 'meta', attr: 'name', key: 'robots' }, 'noindex, nofollow'))
    return () => {
      if (title) document.title = previousTitle
      for (const restore of undo.reverse()) restore()
    }
  }, [title, description, canonical, image, noindex])
}
