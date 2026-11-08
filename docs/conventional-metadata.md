# Conventional message metadata

`src/conventional.ts` validates one commit message or PR title and extracts conventional metadata. It uses the checked-in base Commitlint configuration and parser preset shared by the contribution checks, without loading configuration from an inspected repository. Contribution checks separately require unscoped commit messages and scoped PR titles; this metadata parser continues to accept both forms.

## Behavior

- Accepted input returns its original text, conventional type, nullable scope, description, breaking-change flag, breaking explanations, and warnings.
- A `!` in a valid header or an explicit `BREAKING CHANGE` / `BREAKING-CHANGE` footer declares a breaking change. Ordinary prose does not.
- Invalid input returns rule names and messages, not partial metadata. Empty and whitespace-only input are explicitly invalid because they cannot describe a change.
- Existing warning-level rules remain warnings; error-level violations reject input.
- Automatic non-conventional merge messages are not silently ignored by this metadata validator. CI commit-range checks separately exclude multi-parent commits using Git's `--no-merges` filter; that exception does not apply to individual messages or define release classification.
- Repeated input under the same pinned policy produces the same structured result. Original text is preserved even when the parser normalizes line endings or spacing internally.

The function does not contact GitHub, execute message content, select release members, group changelog entries, interpret PR release context, or call AI. A returned conventional type is not yet a version-bump or changelog-category policy.

## Verification

`pnpm test` runs the Node.js test runner against real behavior. Tests cover accepted types, invalid messages, breaking declarations, warning preservation, original input, and repeatability. No credentials or network access are needed.
