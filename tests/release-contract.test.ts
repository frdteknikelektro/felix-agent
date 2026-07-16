import fs from "node:fs/promises";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

async function readYaml(file: string): Promise<Record<string, any>> {
  return YAML.parse(await fs.readFile(file, "utf8")) as Record<string, any>;
}

describe("0.1.1 release contract", () => {
  it("keeps both Compose runtimes private and least-privileged", async () => {
    for (const file of ["docker-compose.yml", "docker-compose.image.yml"]) {
      const compose = await readYaml(file);
      const service = compose.services.felix;
      expect(service.ports).toContain("127.0.0.1:53318:3000");
      expect(service.read_only).toBe(true);
      expect(service.cap_drop).toContain("ALL");
      expect(service.cap_add).toBeUndefined();
      expect(service.security_opt).toContain("no-new-privileges:true");
      expect(service.tmpfs).toContain("/tmp:rw,noexec,nosuid");
      expect(service.volumes).toContain("./workspace:/home/node");
      expect(service.secrets).toContain(".env");

      const setup = compose.services.setup;
      expect(setup.cap_drop).toContain("ALL");
      expect(setup.security_opt).toContain("no-new-privileges:true");
      expect(setup.read_only).toBe(true);
      expect(setup.tmpfs).toContain("/tmp:rw,noexec,nosuid");
    }
    const imageCompose = await readYaml("docker-compose.image.yml");
    expect(imageCompose.services.felix.image).toBe("${FELIX_IMAGE:-frdinawan/felix-agent:0.1.1}");
    expect(imageCompose.services.setup.image).toBe("${FELIX_IMAGE:-frdinawan/felix-agent:0.1.1}");
    expect(imageCompose.services.setup.profiles).toContain("setup");
    expect(imageCompose.services.setup.command).toEqual(["node", "scripts/setup.mjs"]);
    expect(imageCompose.services.setup.volumes).toContain("./:/config");
  });

  it("publishes with one fast release job", async () => {
    const workflow = await readYaml(".github/workflows/docker-publish.yml");
    expect(workflow.concurrency.group).toBe("release");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    expect(Object.keys(workflow.jobs)).toEqual(["release"]);

    const steps = workflow.jobs.release.steps;
    const build = steps.find((step: any) => step.name === "Build and publish");
    expect(build.with.platforms).toBe("linux/amd64,linux/arm64");
    expect(build.with.tags).toContain("steps.version.outputs.value");
    expect(build.with.tags).toContain(":latest");
    expect(build.with.provenance).toBe(false);
    expect(build.with.sbom).toBe(false);
    expect(build.with["cache-to"]).toBe("type=gha,mode=min");

    expect(steps.some((step: any) => step.name?.match(/scan|audit|test|attest|accept/i))).toBe(false);
    expect(workflow.jobs.scan).toBeUndefined();
    expect(workflow.jobs.verify).toBeUndefined();
    expect(workflow.jobs.attest).toBeUndefined();

    const release = steps.find((step: any) => step.name === "Create GitHub release");
    expect(release.run).toContain("gh release create");
    expect(release.run).toContain("--generate-notes");

    const files = await fs.readdir(".github/workflows");
    expect(files.filter((file) => file.startsWith("release-"))).toEqual([]);
  });
});
