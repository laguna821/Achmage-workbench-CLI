// The design editor (apps/design) is built from Doory, which is under the Attribution Assurance License
// (vendor/doory/LICENSE). Clause 2: "each time the resulting executable program or a program dependent
// thereon is launched, a prominent display (e.g., splash screen or banner text) of the Author's attribution
// information": (a) Name, (b) Professional identification, (c) URL; upstream's NOTICE: "for a web app: on
// its pages". The three items stand here verbatim; apps/design/src/credit.test.ts reads them back from the
// licence text. The design editor's page shows them in its top bar every time it opens (EditorHost.tsx).
export const DOORY_ATTRIBUTION = { name: "Siam", role: "Creator and maintainer of Doory", url: "https://github.com/shaongitbd/doory" } as const;

/** The design editor's credit line, as one string: "Doory · Siam, Creator and maintainer of Doory · <URL>". */
export const DOORY_CREDIT_LINE = `Doory · ${DOORY_ATTRIBUTION.name}, ${DOORY_ATTRIBUTION.role} · ${DOORY_ATTRIBUTION.url}`;
