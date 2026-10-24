import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { DISCORD_URL, DiscordIcon } from "@/components/landing/install";
import { appName, gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // JSX supported
      title: appName,
    },
    links: [
      {
        type: "icon",
        label: "Volt on Discord",
        text: "Discord",
        url: DISCORD_URL,
        icon: <DiscordIcon />,
        external: true,
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
