# Community showcase

The [showcase page](https://crucible.codepawl.com/showcase.html#community) has a section called Made with Crucible. It shows work that other people built with Crucible, and each piece is credited to the person who made it. People submit work in the Show and tell discussions. A maintainer then picks some posts and adds them to the page in a pull request.

## Submit your work

1. Open [Show and tell](https://github.com/codepawl/crucible/discussions/new?category=show-and-tell).
2. Drag in a still or a short video. If we feature your work, we show a 16:9 still at least 1280 px wide.
3. Fill in the credit, a link to the live page, repo or post, and who made the models and assets and their licence.
4. Tick the permission box, then post.

If you have no GitHub account, email the same details to [hello@codepawl.com](mailto:hello@codepawl.com?subject=Crucible%20showcase%20submission). The **or send it by email** link on the showcase page fills in the subject and the fields for you. A post without the permission line is not featured.

## Feature a submission

Do this as a maintainer.

1. Check that the post ticks the permission box and that the licence allows the work to be shown.
2. Save the still as `public/community/<name>.webp`. Use a lowercase name with hyphens, 1600 px wide, at about 200 KB. Keep a local copy and never link to the picture on GitHub or another host.
3. Add an entry to `public/community/featured.json`:

```json
{
  "entries": [
    {
      "title": "Night market",
      "author": "Ada Lovelace",
      "authorUrl": "https://x.com/ada",
      "discussion": "https://github.com/codepawl/crucible/discussions/12",
      "link": "https://example.com/night-market",
      "image": "/community/night-market.webp",
      "width": 1600,
      "height": 900,
      "alt": "A night market street with lanterns, rendered by Crucible",
      "assets": "Own models; HDRI from Poly Haven (CC0)"
    }
  ]
}
```

   - `link` is optional. When it is set, the still opens it. When it is not set, the still opens the discussion.
   - Put the newest entry first.
4. Run `node --test tests/community-showcase.test.js`. The test checks every field and checks that each still exists. It prints each bad field and the value it expects.
5. Reply in the discussion with a link to the showcase page, so the author knows their work is up.

The page hides the grid when the list is empty or does not load, and the submit links always stay on the page.
