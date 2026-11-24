// remark (mdast) plugin: a task item that ends in a to-do marker
// (` ^todo-<anchor>`, src/shared/note-todos.ts) loses the marker text and
// carries the anchor on its list item instead (`data-todo-anchor`), so the
// Markdown component draws a chip naming the to-do rather than the raw
// token. Dependency-free like remark-wikilink, and only applied where the
// notes reading view opts in.

import { TODO_MARKER_TAIL } from '../../src/shared/note-todos';

interface MdNode {
  type: string;
  value?: string;
  checked?: boolean | null;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/** The last text node of an item's content (where its marker would be). */
function lastText(node: MdNode): MdNode | null {
  const children = node.children ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.type === 'text') return child;
    if (child.type === 'paragraph') return lastText(child);
    if (child.type !== 'list') return null;
  }
  return null;
}

function walk(node: MdNode): void {
  if (node.type === 'listItem' && typeof node.checked === 'boolean') {
    const text = lastText(node);
    const tail = text?.value ? TODO_MARKER_TAIL.exec(text.value) : null;
    if (text?.value && tail) {
      text.value = text.value.slice(0, tail.index);
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataTodoAnchor: tail[1] } };
    }
  }
  for (const child of node.children ?? []) walk(child);
}

export function remarkTodoMarker() {
  return (tree: MdNode) => walk(tree);
}
