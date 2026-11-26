// ============================================================
// BCCH MAIL ENGINE — Sanitización HTML (anti-XSS)
// ============================================================
import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "u", "s", "a", "ul", "ol", "li",
  "blockquote", "img", "table", "thead", "tbody", "tr", "td", "th",
  "div", "span", "h1", "h2", "h3", "h4", "hr",
];

const ALLOWED_ATTR: Record<string, string[]> = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "width", "height"],
  "*": ["style"],
};

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTR,
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https", "cid"] },
    allowedClasses: {},
    transformTags: {
      a: (tag, attribs) => {
        attribs.rel = "noopener noreferrer nofollow";
        attribs.target = "_blank";
        return { tagName: tag, attribs };
      },
    },
    // Bloquear scripts, iframes, event handlers, etc.
    disallowedTagsMode: "discard",
    allowVulnerableTags: false,
  });
}

export function stripExternalImages(html: string): string {
  // Por defecto, bloquea imágenes externas (reemplaza por placeholder).
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
    allowedAttributes: { img: ["alt", "data-blocked-src"] },
    allowedSchemes: [],
    transformTags: {
      img: (tag, attribs) => {
        const src = attribs.src;
        if (src) attribs["data-blocked-src"] = src;
        delete attribs.src;
        attribs.alt = attribs.alt || "(imagen externa bloqueada)";
        return { tagName: tag, attribs };
      },
    },
  });
}