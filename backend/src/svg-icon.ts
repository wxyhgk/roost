import { DOMParser, DOMImplementation, XMLSerializer, type Element } from '@xmldom/xmldom';

const NS = 'http://www.w3.org/2000/svg';
const elements = new Set('svg g defs path rect circle ellipse line polyline polygon linearGradient radialGradient stop clipPath mask title desc text tspan'.split(' '));
const attributes = new Set('id viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points transform opacity fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset clip-rule clip-path mask color offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr maskUnits maskContentUnits clipPathUnits preserveAspectRatio font-family font-size font-weight text-anchor dominant-baseline dx dy'.split(' '));
const presentation = new Set('opacity fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset clip-rule clip-path mask color stop-color stop-opacity font-family font-size font-weight text-anchor dominant-baseline'.split(' '));
function safeValue(value: string) {
  // CSS escapes/comments and non-local URLs are not part of the static icon subset.
  if (/[\\\x00-\x1f@<>]/.test(value) || value.includes('/*')) return false;
  const withoutLocalUrls = value.replace(/url\(\s*['"]?#[A-Za-z_][\w:.-]*['"]?\s*\)/gi, '');
  return !/url\s*\(|(?:javascript|data|https?|file):|expression\s*\(/i.test(withoutLocalUrls);
}
/** Rebuild a static SVG tree: never pass uploaded markup through unfiltered. */
export function sanitizeSvgIcon(bytes: Buffer): Buffer {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(source)) throw new Error('SVG document types are not supported');
  const parsed = new DOMParser({ onError: () => { throw new Error('Malformed SVG'); } }).parseFromString(source, 'image/svg+xml');
  const root = parsed.documentElement;
  if (!root || root.localName !== 'svg' || (root.namespaceURI && root.namespaceURI !== NS)) throw new Error('SVG root required');
  const output = new DOMImplementation().createDocument(NS, 'svg', null);
  let count = 0;
  function copy(from: Element, to: Element, depth: number) {
    if (++count > 10000 || depth > 64) throw new Error('SVG is too complex');
    for (let i = 0; i < from.attributes.length; i++) {
      const attr = from.attributes.item(i)!;
      if (attr.namespaceURI) continue;
      if (attributes.has(attr.name) && safeValue(attr.value)) to.setAttribute(attr.name, attr.value);
      if (attr.name === 'style') {
        for (const declaration of attr.value.split(';')) {
          const colon = declaration.indexOf(':');
          const name = declaration.slice(0, colon).trim();
          const value = declaration.slice(colon + 1).trim();
          if (colon > 0 && presentation.has(name) && safeValue(value)) to.setAttribute(name, value);
        }
      }
    }
    for (let node = from.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1) {
        const child = node as Element;
        if (!elements.has(child.localName ?? '') || (child.namespaceURI && child.namespaceURI !== NS)) continue;
        const clean = output.createElementNS(NS, child.localName!);
        to.appendChild(clean); copy(child, clean, depth + 1);
      } else if ((node.nodeType === 3 || node.nodeType === 4) && ['text', 'tspan', 'title', 'desc'].includes(from.localName ?? '')) {
        to.appendChild(output.createTextNode(node.nodeValue ?? ''));
      }
    }
  }
  copy(root, output.documentElement!, 0);
  return Buffer.from(new XMLSerializer().serializeToString(output));
}
