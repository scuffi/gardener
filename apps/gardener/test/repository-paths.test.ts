import { describe, expect, it } from "vitest";
import { listFilesPath, repositoryPath } from "../src/task-runtime/repository-paths";

describe("repository paths", () => {
  it("lists the root for the spellings models use", () => {
    for (const root of [undefined, ".", "", "/", "./"]) expect(listFilesPath(root)).toBe(".");
    expect(listFilesPath("src/lib")).toBe("src/lib");
  });

  it("keeps every other path strict", () => {
    for (const bad of ["/etc", "../x", "a/../b", "a//b", ".//", "//", "a\\b", 3]) {
      expect(() => listFilesPath(bad)).toThrow();
    }
    // Root aliases are list_files only; reading a file still needs a real relative path.
    for (const bad of ["", "/", "./", "."]) expect(() => repositoryPath(bad)).toThrow();
    expect(repositoryPath("README.md")).toBe("README.md");
  });
});
