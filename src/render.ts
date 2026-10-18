import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });

// Links open in the browser only when they are https. Everything else becomes plain text.
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') ?? '';
  if (!/^https:\/\//i.test(href)) {
    tokens[idx].attrSet('href', '#');
    tokens[idx].attrSet('aria-disabled', 'true');
  } else {
    tokens[idx].attrSet('data-external', '1');
  }
  return defaultLink(tokens, idx, options, env, self);
};

// An AI reply must never be able to load an image: the address could carry data out of the editor.
md.renderer.rules.image = (tokens, idx) => md.utils.escapeHtml(tokens[idx].content || 'image');

export function renderMarkdown(text: string): string {
  return md.render(text);
}
