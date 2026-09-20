import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { revalidatePath } from "next/cache";
import { refreshHq } from "@/lib/hq/revalidation";

beforeEach(() => vi.mocked(revalidatePath).mockClear());

describe("HQ mutation invalidation", () => {
  it("keeps the whole layout fresh after edition/catalog changes", () => {
    refreshHq();
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/hq", "layout");
  });

  it("refreshes project dependents including the member detail route pattern", () => {
    refreshHq("projects");
    for (const path of ["/hq", "/hq/projects", "/hq/demo", "/hq/dashboard", "/hq/captain"]) {
      expect(revalidatePath).toHaveBeenCalledWith(path);
    }
    expect(revalidatePath).toHaveBeenCalledWith("/hq/(member)/team/[id]", "page");
    expect(revalidatePath).not.toHaveBeenCalledWith("/hq", "layout");
    for (const path of ["/hq/events", "/hq/partners", "/hq/people", "/hq/admin", "/hq/account"]) {
      expect(revalidatePath).toHaveBeenCalledWith(path);
    }
    expect(revalidatePath).toHaveBeenCalledWith("/hq/(app)/partners/[id]", "page");
    expect(revalidatePath).not.toHaveBeenCalledWith("/hq/login");
  });

  it("limits public interest invalidation to the People view and dashboard", () => {
    refreshHq("interest");
    expect(vi.mocked(revalidatePath).mock.calls).toEqual([["/hq"], ["/hq/people"]]);
  });

  it("refreshes both partner list and dynamic detail when event data changes", () => {
    refreshHq("events");
    expect(revalidatePath).toHaveBeenCalledWith("/hq/partners");
    expect(revalidatePath).toHaveBeenCalledWith("/hq/(app)/partners/[id]", "page");
  });
});
