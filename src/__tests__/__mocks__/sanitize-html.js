// Mock mínimo de sanitize-html para pruebas unitarias.
// Reproduce el comportamiento relevante: elimina <script>, event handlers,
// javascript: URLs y permite bloquear imágenes externas.
// La sanitización real se valida en producción con el paquete genuino.

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeTags(html, tags) {
  let out = html;
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), "");
  }
  return out;
}

function removeEventHandlers(html) {
  return html.replace(/\son\w+\s*=\s*"[^"]*"/gi, "").replace(/\son\w+\s*=\s*'[^']*'/gi, "");
}

function removeJsUrls(html) {
  return html.replace(/javascript:/gi, "");
}

const stub = (html, opts = {}) => {
  let out = html;
  if (opts.allowedTags && Array.isArray(opts.allowedTags)) {
    const allTags = ["script", "iframe", "object", "embed", "style", "img", "a", "p", "div", "span"];
    const disallowed = allTags.filter((t) => !opts.allowedTags.includes(t));
    out = removeTags(out, disallowed);
  } else {
    out = removeTags(out, ["script", "iframe", "object", "embed"]);
  }
  out = removeEventHandlers(out);
  if (opts.allowedSchemes && opts.allowedSchemes.length === 0) {
    // stripExternalImages: conserva data-blocked-src con la URL original.
    out = out.replace(/src\s*=\s*"([^"]*)"/gi, (m, url) => {
      return `data-blocked-src="${url}" alt="(imagen externa bloqueada)"`;
    });
    out = out.replace(/src\s*=\s*'([^']*)'/gi, (m, url) => {
      return `data-blocked-src="${url}" alt="(imagen externa bloqueada)"`;
    });
  }
  out = removeJsUrls(out);
  return out;
};

stub.defaults = { allowedTags: ["p", "a", "img", "br", "span", "div"] };

module.exports = stub;
module.exports.default = stub;
