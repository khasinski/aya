/** Small dependency-free JSX checks compatible with the repository's ESLint major. */
export default {
  rules: {
    'image-alt': {
      meta: { type: 'problem', schema: [], messages: { missing: 'Images need an alt attribute (empty for decorative images).' } },
      create(context) { return { JSXOpeningElement(node) {
        if (node.name.type === 'JSXIdentifier' && node.name.name === 'img' && !node.attributes.some(a => a.type === 'JSXAttribute' && a.name.name === 'alt')) context.report({ node, messageId: 'missing' });
      } }; },
    },
    'focusable-separator': {
      meta: { type: 'problem', schema: [], messages: { missing: 'An adjustable separator needs keyboard focus and an accessible name.' } },
      create(context) { return { JSXOpeningElement(node) {
        const attrs = new Map(node.attributes.filter(a => a.type === 'JSXAttribute').map(a => [a.name.name, a]));
        if (attrs.get('role')?.value?.value !== 'separator' || !attrs.has('aria-valuenow')) return;
        if (!attrs.has('tabIndex') || (!attrs.has('aria-label') && !attrs.has('aria-labelledby'))) context.report({ node, messageId: 'missing' });
      } }; },
    },
    'no-positive-tabindex': {
      meta: { type: 'problem', schema: [], messages: { positive: 'Use DOM order and tabIndex 0 or -1 instead of positive tab order.' } },
      create(context) { return { JSXAttribute(node) {
        if (node.name.name !== 'tabIndex') return;
        const value = node.value?.type === 'JSXExpressionContainer' ? node.value.expression.value : node.value?.value;
        if (Number(value) > 0) context.report({ node, messageId: 'positive' });
      } }; },
    },
  },
};
