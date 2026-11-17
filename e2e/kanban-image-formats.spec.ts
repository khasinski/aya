import { test, expect } from "./fixtures";
import { populatedBoard, seedBoard } from "./helpers/board";

// The board's image picker offers only the formats the board accepts. The MIME
// list stays literal here: it is what the operating system's picker receives.
test.use({ seedOptions: seedBoard(populatedBoard()) });

test("the image picker on the board accepts PNG, JPEG, WebP and GIF only", async ({ window }) => {
  const picker = window.getByTestId("kanban-pane").locator('input[type="file"]');
  await expect(picker).toHaveCount(1);
  await expect(picker).toHaveAttribute("accept", "image/png,image/jpeg,image/webp,image/gif");
});
