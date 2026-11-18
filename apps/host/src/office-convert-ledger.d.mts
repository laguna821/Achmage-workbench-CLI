export type LossFeature = string;
export type Loss = { feature: string; kind: "dropped" | "changed"; count: number };
/** IeumOffice's confirmation box for a Hangul copy that loses something (`detail`: "바뀌는 것"/"빠지는 것" sections of "• " lines). */
export function hwpLossMessageBox(losses: readonly Loss[], passwordDropped: boolean, lang: "ko"): { title?: string; message: string; detail?: string };
