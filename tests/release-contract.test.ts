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

  it("builds and scans an immutable multi-architecture candidate", async () => {
    const workflow = await readYaml(".github/workflows/release-candidate.yml");
    const jobs = workflow.jobs;
    expect(workflow.concurrency.group).toContain("release-candidate-");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    const dependencyValidation = jobs.checks.steps.find((step: any) => step.name === "Validate dependency trees");
    expect(dependencyValidation.run).toBe("npm run validate:deps");
    expect(jobs.build.outputs.digest).toContain("steps.build.outputs.digest");
    const buildWith = jobs.build.steps.find((step: any) => step.id === "build").with;
    expect(buildWith.platforms).toBe("linux/amd64,linux/arm64");
    expect(buildWith.sbom).toBe(true);
    expect(buildWith.provenance).toBe("mode=max");
    expect(buildWith.tags).toContain("candidate-");
    expect(jobs.build.steps.some((step: any) => step.name === "Reject an existing immutable candidate tag")).toBe(true);
    expect(jobs["runtime-smoke"].needs).toBe("build");
    expect(jobs["runtime-smoke"].strategy.matrix.architecture).toEqual(["amd64", "arm64"]);
    const runtimeSmoke = jobs["runtime-smoke"].steps.find(
      (step: any) => step.name === "Exercise the exact candidate image",
    );
    expect(runtimeSmoke.run).toContain("scripts/smoke-candidate-image.sh");
    expect(runtimeSmoke.env.CANDIDATE).toContain("needs.build.outputs.digest");
    expect(jobs.attest.needs).toContain("runtime-smoke");

    const rejectTag = jobs.build.steps.find((step: any) => step.name === "Reject an existing immutable candidate tag");
    expect(rejectTag.run).toContain("assert-image-tag-absent.mjs");
    expect(rejectTag.run).not.toContain("! docker");

    const prepare = jobs.scan.steps.find((step: any) => step.name === "Resolve platform digests and prepare evidence storage");
    expect(prepare.run).toContain("mkdir -p release-evidence");
    expect(prepare.run).toContain("linux/amd64");
    expect(prepare.run).toContain("linux/arm64");

    const scan = jobs.scan.steps.find((step: any) => step.name === "Install Trivy and scan the AMD64 image");
    expect(scan.with["image-ref"]).toContain("steps.platforms.outputs.amd64");
    expect(scan.with.scanners).toContain("misconfig");
    expect(scan.env.TRIVY_IMAGE_CONFIG_SCANNERS).toBe("misconfig,secret");
    expect(scan.with.severity).toContain("UNKNOWN");
    expect(scan.with.output).toContain("/tmp/");
    const evidence = jobs.scan.steps.find((step: any) => step.name === "Generate sanitized multi-architecture evidence");
    expect(evidence.env.ARM64_IMAGE).toContain("steps.platforms.outputs.arm64");
    expect(evidence.run).toContain("--scanners vuln,misconfig,secret");
    expect(evidence.run).toContain("--image-config-scanners misconfig,secret");
    expect(evidence.run).toContain("--scanners vuln,misconfig --image-config-scanners misconfig --format sarif");
    expect(evidence.run).toContain("sanitize-trivy-report.mjs");
    expect(evidence.run).toContain("sbom-amd64.spdx.json");
    expect(evidence.run).toContain("sbom-arm64.spdx.json");
    const policy = jobs.scan.steps.find((step: any) => step.name === "Enforce release risk policy");
    expect(policy.run).toContain("security/vex.openvex.json");
    expect(policy.run).toContain("security/vex-review.json");
    expect(policy.run).toContain("--review-schema security/vex-review.schema.json");
    expect(policy["continue-on-error"]).toBe(true);
    expect(jobs.scan.steps.find((step: any) => step.uses?.startsWith("actions/upload-artifact"))?.if).toBe("always()");
    expect(jobs["code-scanning"].permissions["security-events"]).toBe("write");
    expect(jobs.attest.permissions.attestations).toBe("write");
    expect(jobs.attest.permissions["artifact-metadata"]).toBe("write");
    for (const name of [
      "Attest candidate provenance",
      "Attest AMD64 candidate SBOM",
      "Attest ARM64 candidate SBOM",
    ]) {
      expect(jobs.attest.steps.find((step: any) => step.name === name).uses).toMatch(/^actions\/attest@/);
    }
  });

  it("publishes only the exact verified candidate and promotes latest separately", async () => {
    const publish = await readYaml(".github/workflows/release-publish.yml");
    expect(publish.concurrency.group).toContain("release-publish-");
    expect(publish.concurrency["cancel-in-progress"]).toBe(false);
    const download = publish.jobs.verify.steps.find((step: any) => step.name === "Download exact candidate evidence");
    expect(download.run).toContain("gh api");
    expect(download.run).toContain(".conclusion");
    expect(download.run).toContain(".path");
    expect(download.run).toContain(".github/workflows/release-candidate.yml");
    expect(download.run).toContain(".event");
    expect(download.run).toContain("workflow_dispatch");
    expect(download.run).toContain("candidate-runtime-smoke-amd64");
    expect(download.run).toContain("candidate-runtime-smoke-arm64");
    const verify = publish.jobs.verify.steps.find((step: any) => step.name === "Verify candidate binding and complete evidence");
    expect(verify.run).toContain("verify-release-candidate.mjs");
    expect(verify.run).toContain("--evidence-dir release-evidence");
    expect(verify.run).toContain("imagetools inspect --raw");
    expect(verify.run).toContain("--registry-manifest /tmp/registry-manifest.json");
    expect(verify.run).toContain("runtime-smoke-amd64.json");
    expect(verify.run).toContain("runtime-smoke-arm64.json");
    expect(verify.run).toContain("--image \"${IMAGE}\"");
    expect(verify.run).toContain("--report release-evidence/trivy-full.json");
    expect(verify.run).toContain("--review-schema security/vex-review.schema.json");
    expect(verify.run).toContain("--output /tmp/recomputed-policy.json");
    expect(verify.run).toContain("recomputed-policy.sorted.json");
    expect(verify.run.match(/gh attestation verify/g)).toHaveLength(3);
    expect(verify.run).toContain("--source-digest \"$COMMIT\"");
    expect(verify.run).toContain("https://spdx.dev/Document/v2.3");
    expect(verify.run).toContain("generate-release-evidence.mjs");
    expect(verify.run).toContain("--artifact-dir release-evidence");
    expect(verify.run).toContain("manual-acceptance.md");
    expect(publish.on.workflow_dispatch.inputs.manual_evidence.required).toBe(true);
    const publication = publish.jobs.publish.steps.find((step: any) => step.name === "Create immutable source and Docker tags");
    expect(publication.run).toContain("git tag -a");
    expect(publication.run).toContain("imagetools create");
    expect(publication.run).toContain("imagetools inspect");
    expect(publication.run).toContain("git ls-remote --exit-code");
    expect(publication.run).toContain("check-image-tag-compatible.mjs");
    expect(publication.run).toContain("existing source tag points to a different commit");
    expect(publication.run).not.toContain("test -z \"$(git ls-remote");
    const githubRelease = publish.jobs.publish.steps.find(
      (step: any) => step.name === "Create GitHub Release with sanitized evidence",
    );
    expect(githubRelease.run).toContain("gh release view");
    expect(githubRelease.run).toContain("gh release upload");
    expect(githubRelease.run).toContain("cmp");
    expect(githubRelease.run).not.toContain("--clobber");

    const promotionWorkflow = await readYaml(".github/workflows/release-promote-latest.yml");
    expect(promotionWorkflow.concurrency.group).toBe("release-promote-latest");
    const promotion = promotionWorkflow.jobs.promote.steps.find((step: any) => step.name === "Promote only the immutable 0.1.1 digest");
    expect(promotion.run).toContain("${IMAGE}:0.1.1");
    expect(promotion.run).toContain("imagetools create");
    expect(Object.keys(promotionWorkflow.on.workflow_dispatch.inputs)).toEqual(["digest"]);
  });

  it("pins every third-party action to a full commit SHA", async () => {
    for (const file of ["ci.yml", "release-candidate.yml", "release-publish.yml", "release-promote-latest.yml"]) {
      const text = await fs.readFile(`.github/workflows/${file}`, "utf8");
      for (const match of text.matchAll(/uses:\s+([^\s#]+)/g)) {
        expect(match[1], `${file}: ${match[1]}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});
