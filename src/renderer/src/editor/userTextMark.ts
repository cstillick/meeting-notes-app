import { Mark } from '@tiptap/core'

/**
 * Marks spans that originated from the user's own rough notes. Granola
 * convention: user text renders black, AI-added text renders gray.
 */
export const UserTextMark = Mark.create({
  name: 'userText',

  parseHTML() {
    return [{ tag: 'span[data-user-text]' }]
  },

  renderHTML() {
    return ['span', { 'data-user-text': 'true' }, 0]
  }
})
