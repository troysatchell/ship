import EmojiPicker, { Theme, type EmojiClickData } from 'emoji-picker-react';

/**
 * The `emoji-picker-react` widget, isolated in its own module so it can be
 * `React.lazy`-loaded (BUN-4 / TRO-200).
 *
 * `emoji-picker-react` is 186.4 kB raw / 39.1 kB gzip and has exactly one
 * consumer in the app: the project-icon PropertyRow in ProjectSidebar. Keeping
 * the import here — rather than in EmojiPicker.tsx — is what creates the split
 * boundary: EmojiPicker.tsx must not name the package at value level, or the
 * bundler pulls it back into the parent chunk.
 *
 * The `EmojiClickData` -> string unwrapping also lives here on purpose, so the
 * caller never has to import a type from the package either.
 */
export default function EmojiPickerBody({ onSelect }: { onSelect: (emoji: string) => void }) {
  return (
    <EmojiPicker
      onEmojiClick={(emojiData: EmojiClickData) => onSelect(emojiData.emoji)}
      skinTonesDisabled={true}
      theme={Theme.DARK}
      height={350}
      width={300}
      searchPlaceholder="Search emoji..."
      previewConfig={{ showPreview: false }}
    />
  );
}
