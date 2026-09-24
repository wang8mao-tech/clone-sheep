import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskRow } from "./TaskRow.js";

/** CMP-002 行的左侧竖线：只在调用方要（变体队列）时画；客户页这类表不画，列不会错开（8.3 第二轮审查 S2-M1） */

function renderRow(accent?: "primary" | "warning" | "none") {
  render(
    <ul>
      <TaskRow title="行" columns={[]} {...(accent ? { accent } : {})} />
    </ul>,
  );
  return screen.getByRole("listitem");
}

describe("TaskRow accent", () => {
  it("不传：没有左边框", () => {
    expect(renderRow()).not.toHaveClass("border-l-2");
  });

  it.each([
    ["primary", "border-l-primary"],
    ["warning", "border-l-warning"],
    ["none", "border-l-transparent"],
  ] as const)("%s：2px 竖线 %s", (accent, color) => {
    expect(renderRow(accent)).toHaveClass("border-l-2", color);
  });
});
