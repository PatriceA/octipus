/**
 * `.md` files imported as strings.
 *
 * The role prompts live beside their config as markdown and are imported
 * rather than read from disk, so the bundler inlines them and the shipped
 * artifact carries its prompts instead of looking for a directory that is not
 * there. `scripts/build.ts` and `vitest.config.ts` both register the loader.
 */
declare module '*.md' {
  const content: string;
  export default content;
}
