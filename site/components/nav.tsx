import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { Container, Button, cn } from "../ui";
import { Logo } from "./logo";
import type { Route } from "../use-route";

const LINKS: { label: string; route: Route }[] = [
  { label: "首页", route: "home" },
  { label: "功能", route: "features" },
  { label: "下载", route: "download" },
  { label: "关于", route: "about" },
];

export function Nav({ route, navigate }: { route: Route; navigate: (r: Route) => void }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const go = (r: Route) => {
    navigate(r);
    setOpen(false);
  };

  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-b transition-colors",
        scrolled ? "border-border bg-background/85 backdrop-blur-md" : "border-transparent",
      )}
    >
      <Container className="flex h-16 items-center justify-between">
        <button onClick={() => go("home")} aria-label="Lattice 首页" className="shrink-0">
          <Logo />
        </button>

        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <button
              key={link.route}
              onClick={() => go(link.route)}
              className={cn(
                "rounded-full px-4 py-2 text-sm transition-colors",
                route === link.route
                  ? "text-foreground"
                  : "text-muted hover:text-foreground",
              )}
            >
              {link.label}
            </button>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Button variant="accent" size="sm" onClick={() => go("download")}>
            下载 for macOS
          </Button>
        </div>

        <button
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-foreground md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "关闭菜单" : "打开菜单"}
          aria-expanded={open}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </Container>

      {open && (
        <div className="border-t border-border bg-background md:hidden">
          <Container className="flex flex-col gap-1 py-4">
            {LINKS.map((link) => (
              <button
                key={link.route}
                onClick={() => go(link.route)}
                className={cn(
                  "rounded-lg px-4 py-3 text-left text-sm",
                  route === link.route ? "bg-accent-soft text-accent-strong" : "text-muted",
                )}
              >
                {link.label}
              </button>
            ))}
            <Button variant="accent" size="md" className="mt-2" onClick={() => go("download")}>
              下载 for macOS
            </Button>
          </Container>
        </div>
      )}
    </header>
  );
}
