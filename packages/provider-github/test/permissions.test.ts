import { describe, expect, it } from "vitest";
import { operationKindValues, type OperationKind } from "@gardener/contracts";
import {
  GITHUB_PERMISSION_KEYS,
  OPERATION_TOKEN_PERMISSIONS,
  mergePermissions,
  operationApplyPermissions,
  operationPlanningReadPermissions,
  scopeKey,
  scopeLevel,
} from "../src/permissions";

describe("operation permission mapping", () => {
  it("covers every operation kind exactly once", () => {
    expect(Object.keys(OPERATION_TOKEN_PERMISSIONS).sort()).toEqual([...operationKindValues].sort());
    for (const kind of operationKindValues) {
      const scopes = OPERATION_TOKEN_PERMISSIONS[kind];
      expect(scopes.length, kind).toBeGreaterThan(0);
      expect(new Set(scopes).size, kind).toBe(scopes.length);
      for (const scope of scopes) {
        expect(GITHUB_PERMISSION_KEYS, `${kind} -> ${scope}`).toContain(scopeKey(scope));
        expect(["read", "write"], `${kind} -> ${scope}`).toContain(scopeLevel(scope));
      }
    }
  });

  it("derives check.rerun from the Checks API only, never Actions", () => {
    // The executor calls /check-runs/{id} and /commits/{sha}/check-runs. It
    // never touches the Actions API, so granting `actions` would be excess
    // authority on the privileged apply job.
    expect(operationApplyPermissions("check.rerun")).toEqual({ checks: "write" });
    expect(operationPlanningReadPermissions("check.rerun")).toEqual({ checks: "read" });

    for (const kind of operationKindValues) {
      expect(operationApplyPermissions(kind).actions, kind).toBeUndefined();
      expect(operationPlanningReadPermissions(kind).actions, kind).toBeUndefined();
    }
  });

  it("derives pull_request.merge with its branch-protection read scopes", () => {
    expect(operationApplyPermissions("pull_request.merge")).toEqual({
      checks: "read",
      contents: "write",
      "pull-requests": "write",
      statuses: "read",
    });
    expect(operationPlanningReadPermissions("pull_request.merge")).toEqual({
      checks: "read",
      contents: "read",
      "pull-requests": "read",
      statuses: "read",
    });
  });

  it("never downgrades write to read when merging and keeps canonical order", () => {
    const merged = mergePermissions({ contents: "read" }, { contents: "write" }, { issues: "read" });
    expect(merged).toEqual({ contents: "write", issues: "read" });
    expect(Object.keys(mergePermissions(
      { statuses: "read" },
      { issues: "write" },
      { actions: "read" },
    ))).toEqual(["actions", "issues", "statuses"]);
  });

  it("emits read-only planning scopes and never grants id-token from an operation", () => {
    for (const kind of operationKindValues) {
      for (const level of Object.values(operationPlanningReadPermissions(kind))) {
        expect(level, kind).toBe("read");
      }
      expect(operationPlanningReadPermissions(kind)["id-token"], kind).toBeUndefined();
    }
  });

  it("grants write only where the operation actually mutates", () => {
    const readOnlyApply = operationKindValues.filter(
      (kind: OperationKind) => !Object.values(operationApplyPermissions(kind)).includes("write"),
    );
    expect(readOnlyApply).toEqual([]);
  });
});
