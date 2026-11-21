import { common, createLowlight } from 'lowlight';
import cmake from 'highlight.js/lib/languages/cmake';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import elixir from 'highlight.js/lib/languages/elixir';
import gradle from 'highlight.js/lib/languages/gradle';
import haskell from 'highlight.js/lib/languages/haskell';
import julia from 'highlight.js/lib/languages/julia';
import latex from 'highlight.js/lib/languages/latex';
import nim from 'highlight.js/lib/languages/nim';
import powershell from 'highlight.js/lib/languages/powershell';
import protobuf from 'highlight.js/lib/languages/protobuf';
import scala from 'highlight.js/lib/languages/scala';
import type { Element, ElementContent, Root } from 'hast';

/** Loaded on demand by the file preview, so the grammars stay out of the main bundle. */
const lowlight = createLowlight({ ...common, cmake, dart, dockerfile, elixir, gradle, haskell, julia, latex, nim, powershell, protobuf, scala });

/** One run of text and the token classes of every enclosing span. */
export interface Segment { text: string; className?: string }

/**
 * Highlight the whole file once, then cut the token tree at newlines. A string or comment
 * that spans lines keeps its classes on each line, so every line renders on its own.
 */
export function highlightLines(text: string, language: string): Segment[][] {
  const lines: Segment[][] = [[]];
  const walk = (nodes: ElementContent[] | Root['children'], classes: string[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const className = classes.length ? classes.join(' ') : undefined;
        node.value.split('\n').forEach((part, index) => {
          if (index) lines.push([]);
          if (part) lines[lines.length - 1].push({ text: part, className });
        });
      } else if (node.type === 'element') {
        const own = (node as Element).properties.className;
        walk(node.children, Array.isArray(own) ? [...classes, ...own.map(String)] : classes);
      }
    }
  };
  walk(lowlight.highlight(language, text).children, []);
  return lines;
}
