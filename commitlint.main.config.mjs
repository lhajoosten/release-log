const githubCoauthor =
  /^Co-authored-by: [^<>\r\n]+ <\d+\+[a-z\d-]+(?:\[bot\])?@users\.noreply\.github\.com>$/iu;
const footerMaximum = 100;

/** @type {import("@commitlint/types").SyncRule} */
const checkFooterLength = ({ footer }) => [
  (footer ?? "")
    .split("\n")
    .every((line) => line.length <= footerMaximum || githubCoauthor.test(line)),
  `footer's lines must not be longer than ${footerMaximum} characters except GitHub co-author trailers`,
];

export default {
  extends: ["./commitlint.base.config.mjs"],
  plugins: [
    {
      rules: {
        "github-footer-max-line-length": checkFooterLength,
      },
    },
  ],
  rules: {
    "footer-max-line-length": [0],
    "github-footer-max-line-length": [2, "always"],
  },
};
