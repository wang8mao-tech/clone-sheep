import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RatesTable } from "./RatesTable.js";
import type { Rate } from "../../lib/estimate.js";
import { renderWithProviders, stubFetch } from "../../test/harness.js";

/** 设置页费率表：列、加（校验）、删 */

function backend(initial: Rate[] = []) {
  const db = { rates: initial, next: 10 };
  stubFetch({
    "/api/settings/rates": () => ({ body: { rates: db.rates } }),
    "PUT /api/settings/rates": (init) => {
      const body = JSON.parse(init?.body as string) as Omit<Rate, "id" | "updatedAt" | "note" | "endpoint"> &
        Partial<Pick<Rate, "note" | "endpoint">>;
      const rate: Rate = {
        id: db.next++,
        updatedAt: "",
        capability: body.capability,
        unit: body.unit,
        usd: body.usd,
        note: body.note ?? null,
        endpoint: body.endpoint ?? null,
      };
      db.rates = [...db.rates.filter((r) => !(r.capability === rate.capability && r.endpoint === rate.endpoint)), rate];
      return { body: { rate } };
    },
    "DELETE /api/settings/rates/:id": (_init, url) => {
      const id = Number(url?.split("/").at(-1));
      db.rates = db.rates.filter((r) => r.id !== id);
      return { body: { ok: true } };
    },
  });
  return db;
}

describe("费率表", () => {
  it("空表给一句说明；加一条后出现在表里；删掉就没了", async () => {
    const db = backend();
    renderWithProviders(<RatesTable />);
    expect(await screen.findByText(/还没有费率/)).toBeTruthy();

    await userEvent.type(screen.getByLabelText("能力"), "@hypit/seedance@1#seedance-2-mini");
    await userEvent.selectOptions(screen.getByLabelText("单位"), "second");
    await userEvent.type(screen.getByLabelText("单价 USD"), "0.056");
    await userEvent.click(screen.getByRole("button", { name: "保存费率" }));
    await waitFor(() => expect(db.rates).toHaveLength(1));
    const row = (await screen.findByText("@hypit/seedance@1#seedance-2-mini")).closest("tr") as HTMLElement;
    expect(within(row).getByText("每秒")).toBeTruthy();
    // 按秒计价的单价不到一分钱：不能被两位小数吃掉
    expect(within(row).getByText("$0.056")).toBeTruthy();
    expect(within(row).getByText("任意")).toBeTruthy();

    await userEvent.click(within(row).getByRole("button", { name: /删除 .* 的费率/ }));
    await waitFor(() => expect(db.rates).toHaveLength(0));
    expect(await screen.findByText(/还没有费率/)).toBeTruthy();
  });

  it("能力名为空或单价不是数：就地报错，不发请求", async () => {
    const db = backend();
    renderWithProviders(<RatesTable />);
    await screen.findByText(/还没有费率/);
    await userEvent.click(screen.getByRole("button", { name: "保存费率" }));
    expect((await screen.findByRole("alert")).textContent).toContain("能力名不能为空");
    await userEvent.type(screen.getByLabelText("能力"), "@hypit/x@1#y");
    // 单价空着：Number("") 是 0，不能悄悄存成免费
    await userEvent.click(screen.getByRole("button", { name: "保存费率" }));
    expect((await screen.findByRole("alert")).textContent).toContain("单价要是 0 到 10000 之间的数字");
    await userEvent.type(screen.getByLabelText("单价 USD"), "abc");
    await userEvent.click(screen.getByRole("button", { name: "保存费率" }));
    expect((await screen.findByRole("alert")).textContent).toContain("单价要是 0 到 10000 之间的数字");
    await userEvent.clear(screen.getByLabelText("单价 USD"));
    await userEvent.type(screen.getByLabelText("单价 USD"), "10001");
    await userEvent.click(screen.getByRole("button", { name: "保存费率" }));
    expect((await screen.findByRole("alert")).textContent).toContain("单价要是 0 到 10000 之间的数字");
    expect(db.rates).toHaveLength(0);
  });
});
