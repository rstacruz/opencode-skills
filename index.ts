/**
 * OpenCode Skills Plugin
 * Implements Anthropic's Agent Skills Specification (v1.0) for OpenCode.
 *
 * @see https://github.com/anthropics/skills
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import matter from "gray-matter"
import { Glob } from "bun"
import { join, dirname, basename, relative, sep } from "path"
import { z } from "zod"
import os from "os"

const SKILL_PROMPT = `<skill name="%{name}">

%{content}

</skill>`

const RESOURCES_PROMPT = `<skill_resources>
IMPORTANT: The skill %{name} may reference certain resource files. Use their full paths:

%{paths}
</skill_resources>`

// Types
interface Skill {
  name: string // From frontmatter (e.g., "brand-guidelines")
  fullPath: string // Full directory path to skill
  toolName: string // Generated tool name (e.g., "skills_brand_guidelines")
  description: string // From frontmatter
  allowedTools?: string[] // Parsed but not enforced (agent-level restrictions instead)
  metadata?: Record<string, string>
  license?: string
  content: string // Markdown body
  path: string // Full path to SKILL.md
}

// Validation Schema
const SkillFrontmatterSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens")
    .min(1, "Name cannot be empty"),
  description: z
    .string()
    .min(20, "Description must be at least 20 characters for discoverability"),
  license: z.string().optional(),
  "allowed-tools": z.array(z.string()).optional(),
  metadata: z.record(z.string()).optional(),
})

type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

/**
 * Generate tool name from skill path
 * Examples:
 *   .opencode/skills/brand-guidelines/SKILL.md → skills_brand_guidelines
 *   .opencode/skills/document-skills/docx/SKILL.md → skills_document_skills_docx
 */
function generateToolName(skillPath: string, baseDir: string): string {
  const rel = relative(baseDir, skillPath)
  const dirPath = dirname(rel)
  const components = dirPath.split(sep).filter((c) => c !== ".")
  return "skills_" + components.join("_").replace(/-/g, "_")
}

/**
 * Parse a SKILL.md file and return structured skill data
 * Returns null if parsing fails (with error logging)
 */
async function parseSkill(
  skillPath: string,
  baseDir: string,
): Promise<Skill | null> {
  try {
    // Read file
    const content = await Bun.file(skillPath).text()

    // Parse YAML frontmatter
    const { data, content: markdown } = matter(content)

    // Validate frontmatter schema
    let frontmatter: SkillFrontmatter
    try {
      frontmatter = SkillFrontmatterSchema.parse(data)
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error(`❌ Invalid frontmatter in ${skillPath}:`)
        error.errors.forEach((err) => {
          console.error(`   - ${err.path.join(".")}: ${err.message}`)
        })
      }
      return null
    }

    // Validate name matches directory
    const skillDir = basename(dirname(skillPath))
    if (frontmatter.name !== skillDir) {
      console.error(
        `❌ Name mismatch in ${skillPath}:`,
        `\n   Frontmatter name: "${frontmatter.name}"`,
        `\n   Directory name: "${skillDir}"`,
        `\n   Fix: Update the 'name' field in SKILL.md to match the directory name`,
      )
      return null
    }

    // Generate tool name from path
    const toolName = generateToolName(skillPath, baseDir)

    return {
      name: frontmatter.name,
      fullPath: dirname(skillPath),
      toolName,
      description: frontmatter.description,
      allowedTools: frontmatter["allowed-tools"],
      metadata: frontmatter.metadata,
      license: frontmatter.license,
      content: markdown.trim(),
      path: skillPath,
    }
  } catch (error) {
    console.error(
      `❌ Error parsing skill ${skillPath}:`,
      error instanceof Error ? error.message : String(error),
    )
    return null
  }
}

/**
 * Discover all SKILL.md files in the specified base paths
 */
async function discoverSkills(basePaths: string[]): Promise<Skill[]> {
  const skills: Skill[] = []

  for (const basePath of basePaths) {
    try {
      // Find all SKILL.md files recursively
      const glob = new Glob("**/SKILL.md")

      for await (const match of glob.scan({
        cwd: basePath,
        absolute: true,
      })) {
        const skill = await parseSkill(match, basePath)
        if (skill) {
          skills.push(skill)
        }
      }
    } catch (error) {
      // Log warning but continue with other paths
      // console.warn(
      //   `!  Could not scan skills directory: ${basePath}`,
      //   `\n   This is normal if the directory doesn't exist yet.`,
      //   `\n   Create it with: mkdir -p ${basePath}`,
      // );
    }
  }

  // Detect duplicate tool names
  const toolNames = new Set<string>()
  const duplicates = []

  for (const skill of skills) {
    if (toolNames.has(skill.toolName)) {
      duplicates.push(skill.toolName)
    }
    toolNames.add(skill.toolName)
  }

  if (duplicates.length > 0) {
    console.warn(`!  Duplicate tool names detected:`, duplicates)
  }

  return skills
}

// Main Plugin Export
export const SkillsPlugin: Plugin = async (ctx) => {
  // Determine config path: $XDG_CONFIG_HOME/opencode/skills or ~/.config/opencode/skills
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  const configSkillsPath = xdgConfigHome
    ? join(xdgConfigHome, "opencode/skills")
    : join(os.homedir(), ".config/opencode/skills")

  const skills = await discoverSkills([
    join(ctx.directory, ".opencode/skills"),
    join(os.homedir(), ".opencode/skills"),
    configSkillsPath,
  ])

  // Create a tool for each skill
  const tools: Record<string, any> = {}

  for (const skill of skills) {
    tools[skill.toolName] = tool({
      description: skill.description,
      args: {},
      async execute(args, toolCtx) {
        let prompt = SKILL_PROMPT.replaceAll("%{name}", skill.name)
          .replaceAll("%{fullPath}", skill.fullPath)
          .replaceAll("%{content}", skill.content)

        const glob = new Glob("**/*")
        const resourcePaths: string[] = []

        for await (const match of glob.scan({
          cwd: skill.fullPath,
          absolute: true,
        })) {
          // Exclude SKILL.md
          if (basename(match) === "SKILL.md") continue
          resourcePaths.push(match)
        }

        if (resourcePaths.length > 0) {
          prompt +=
            "\n\n" +
            RESOURCES_PROMPT.replaceAll("%{name}", skill.name).replaceAll(
              "%{paths}",
              resourcePaths.join("\n"),
            )
        }

        return prompt
      },
    })
  }

  return { tool: tools }
}
