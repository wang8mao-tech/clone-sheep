import { beforeEach, describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { TPL } from "../../test/agent-drawer-kit.js";
import { ControlledEventSource } from "../../test/fake-event-source.js";
import { batch, installVariantSources, mountVariants, variant, variantsBackend } from "../../test/variants-kit.js";

/** ④ 变体队列的列头与批量结束 toast（Design-Brief §6.2「3 条完成，1 条失败」，8.3 第二、三轮审查） */

beforeEach(() => {
  installVariantSources();
});

describe("列头与批量结束", () => {
  it("列头写明各列是什么", async () => {
    variantsBackend([batch()]);
    await mountVariants();
    await screen.findByRole("list", { name: "批次 毒舌风格 的变体" });
    for (const label of ["状态", "变体", "模型", "用时", "估价", "花费"])
      expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("一批全部结束时一条 toast「n 条完成，m 条失败」；打开页面时就已结束的批次不报", async () => {
    const old = batch({ id: "b0", note: "老批次", variants: [variant(20, { status: "done" })] });
    const db = variantsBackend([
      batch({ variants: [variant(1, { status: "agent_running" }), variant(2, { status: "building" })] }),
      old,
    ]);
    await mountVariants();
    await screen.findByRole("list", { name: "批次 毒舌风格 的变体" });
    expect(screen.queryByText(/「老批次」/)).toBeNull();
    // 同时冒出来一批从没见过「没结束」样子的（别的标签页提交、已经做完）：不报
    const appeared = batch({ id: "b9", note: "别处提交的", variants: [variant(30, { status: "done" })] });
    db.batches = [
      appeared,
      batch({ variants: [variant(1, { status: "done" }), variant(2, { status: "failed" })] }),
      old,
    ];
    act(() => {
      for (const es of ControlledEventSource.instances) {
        if (!es.closed && es.topics.includes(`template:${TPL}`)) es.emit("variants", `template:${TPL}`, {});
      }
    });
    expect(await screen.findByText("「毒舌风格」1 条完成，1 条失败")).toBeInTheDocument();
    expect(screen.queryByText(/「老批次」/)).toBeNull();
    expect(screen.queryByText(/「别处提交的」/)).toBeNull();
  });

  it("熔断的还等人决定：不算结束、不弹 toast；取消的算结束，文字里带「n 条已取消」", async () => {
    const db = variantsBackend([
      batch({ variants: [variant(1, { status: "agent_running" }), variant(2, { status: "agent_running" })] }),
    ]);
    await mountVariants();
    await screen.findByRole("list", { name: "批次 毒舌风格 的变体" });
    const push = () =>
      act(() => {
        for (const es of ControlledEventSource.instances) {
          if (!es.closed && es.topics.includes(`template:${TPL}`)) es.emit("variants", `template:${TPL}`, {});
        }
      });
    db.batches = [batch({ variants: [variant(1, { status: "done" }), variant(2, { status: "tripped" })] })];
    push();
    await waitFor(() => expect(screen.getAllByRole("listitem")[1]).toHaveTextContent("已熔断"));
    expect(screen.queryByText(/条完成/)).toBeNull();
    db.batches = [batch({ variants: [variant(1, { status: "done" }), variant(2, { status: "cancelled" })] })];
    push();
    expect(await screen.findByText("「毒舌风格」1 条完成，1 条已取消")).toBeInTheDocument();
  });
});
