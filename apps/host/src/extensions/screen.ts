import { createHash, randomBytes } from "node:crypto";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { ExtensionCall, ExtensionScreen } from "@workbench/contracts";

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const allowed = new Set(["div", "span", "p", "h1", "h2", "h3", "label", "input", "textarea", "select", "option", "button", "pre", "code", "strong", "em", "ul", "ol", "li", "br", "hr"]);
function render(node: DefaultTreeAdapterTypes.ChildNode): string {
  if (node.nodeName === "#text") return escape((node as DefaultTreeAdapterTypes.TextNode).value);
  if (!("tagName" in node) || !allowed.has(node.tagName)) return "";
  const attributes = node.attrs.filter(attribute => ["name", "value", "placeholder", "title", "data-extension-tool", "data-extension-output", "aria-label", "disabled", "multiple", "selected"].includes(attribute.name)
    || attribute.name === "type" && ["text", "number", "checkbox", "button"].includes(attribute.value));
  return `<${node.tagName}${attributes.map(attribute => ` ${attribute.name}="${escape(attribute.value.slice(0, 2000))}"`).join("")}>`
    + node.childNodes.map(render).join("") + (["input", "br", "hr"].includes(node.tagName) ? "" : `</${node.tagName}>`);
}

/** Declarative HTML only; author scripts, URL attributes and inline event handlers never execute. */
export function createExtensionScreen(call: ExtensionCall, source: string): ExtensionScreen {
  const nonce = randomBytes(24).toString("base64url"), expiresAt = Date.now() + 5 * 60_000;
  const html = parseFragment(source).childNodes.map(render).join("");
  const script = `(() => { const nonce=${JSON.stringify(nonce)}, base=${JSON.stringify({ ...call, input: undefined }).replace(/</g, "\\u003c")}, pending=new Set();
document.addEventListener('click',event=>{const button=event.target.closest('[data-extension-tool]');if(!button)return;
const input={};for(const node of document.querySelectorAll('[name]'))input[node.name]=node.type==='checkbox'?node.checked:node.value;
const requestId=String(Date.now())+'-'+Math.random().toString(36).slice(2);pending.add(requestId);
parent.postMessage({type:'workbench.extension.call',nonce,requestId,call:{...base,capability:'tool',contributionId:button.dataset.extensionTool,input}},'*');});
addEventListener('message',event=>{const m=event.data;if(event.source!==parent||!m||m.type!=='workbench.extension.result'||m.nonce!==nonce||!pending.delete(m.requestId))return;
const out=document.querySelector('[data-extension-output]');if(out)out.textContent=m.error||JSON.stringify(m.output,null,2);});})();`;
  const style = "body{font:16px system-ui;padding:16px;color:#172d3e;background:#fff}button,input,select,textarea{font:inherit;max-width:100%;margin:4px;padding:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{cursor:pointer}";
  const digest = (value: string) => createHash("sha256").update(value).digest("base64");
  const csp = `default-src 'none'; script-src 'sha256-${digest(script)}'; style-src 'sha256-${digest(style)}'; connect-src 'none'; img-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
  return { extensionId: call.extensionId, artifactHash: call.artifactHash, grantGeneration: call.grantGeneration,
    workspaceId: call.workspaceId, screenId: call.contributionId, nonce, expiresAt,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><style>${style}</style></head><body>${html}<script>${script}</script></body></html>` };
}
