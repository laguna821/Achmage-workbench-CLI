import { useEffect, useState } from "react";
import { designToken } from "./design.ts";

// Page images of Word/PowerPoint/Excel documents, rendered by IeumOffice on the gateway. Images
// need the token, so they are fetched and shown as blob: URLs; revisions never change, so the
// URLs are kept for the session.

export type OfficePageInfo = { page: number; width: number; height: number };
export type PageSource = { artifactId: string; revision: number } | { proposalId: string; side: "base" | "proposed" };

const images = new Map<string, Promise<string>>();
const lists = new Map<string, Promise<OfficePageInfo[]>>();

async function get(path: string) {
  const response = await fetch(path, { headers: { authorization: `Bearer ${designToken()}` } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? response.statusText);
  }
  return response;
}

const base = (source: PageSource) => ("proposalId" in source ? `/api/proposals/${source.proposalId}` : `/api/artifacts/${source.artifactId}`);
const query = (source: PageSource) => ("proposalId" in source ? `side=${source.side}` : `revision=${source.revision}`);
const keyOf = (source: PageSource) => ("proposalId" in source ? `${source.proposalId}:${source.side}` : `${source.artifactId}@${source.revision}`);

export function officePages(source: PageSource): Promise<OfficePageInfo[]> {
  const key = keyOf(source);
  let list = lists.get(key);
  if (!list) {
    list = get(`${base(source)}/office-pages?${query(source)}`).then(async (response) => ((await response.json()) as { pages: OfficePageInfo[] }).pages);
    list.catch(() => lists.delete(key));
    lists.set(key, list);
  }
  return list;
}

export function officePageImage(source: PageSource, page: number): Promise<string> {
  const key = `${keyOf(source)}#${page}`;
  let url = images.get(key);
  if (!url) {
    url = get(`${base(source)}/office-page?${query(source)}&page=${page}`).then(async (response) => URL.createObjectURL(await response.blob()));
    url.catch(() => images.delete(key));
    images.set(key, url);
    if (images.size > 300) images.delete(images.keys().next().value!);
  }
  return url;
}

/** The page list of a revision or of a proposal side; null while it is rendered. */
export function useOfficePages(source: PageSource | null) {
  const key = source ? keyOf(source) : "";
  const [state, setState] = useState<{ key: string; pages: OfficePageInfo[] | null; error: string | null }>({ key: "", pages: null, error: null });
  useEffect(() => {
    if (!source) return;
    let active = true;
    officePages(source).then(
      (pages) => active && setState({ key, pages, error: null }),
      (error: Error) => active && setState({ key, pages: null, error: error.message }),
    );
    return () => {
      active = false;
    };
    // The key covers the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { pages: null, error: null };
}

/** One page image URL (blob:), null while it loads. */
export function useOfficePage(source: PageSource | null, page: number) {
  const key = source ? `${keyOf(source)}#${page}` : "";
  const [state, setState] = useState<{ key: string; url: string | null; error: string | null }>({ key: "", url: null, error: null });
  useEffect(() => {
    if (!source) return;
    let active = true;
    officePageImage(source, page).then(
      (url) => active && setState({ key, url, error: null }),
      (error: Error) => active && setState({ key, url: null, error: error.message }),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { url: null, error: null };
}
