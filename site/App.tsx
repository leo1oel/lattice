import { useRoute } from "./use-route";
import { Nav } from "./components/nav";
import { Footer } from "./components/footer";
import { Home } from "./pages/home";
import { Features } from "./pages/features";
import { Download_ } from "./pages/download";
import { About } from "./pages/about";

export function App() {
  const [route, navigate] = useRoute();

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <Nav route={route} navigate={navigate} />
      <main className="flex-1">
        {route === "home" && <Home navigate={navigate} />}
        {route === "features" && <Features navigate={navigate} />}
        {route === "download" && <Download_ />}
        {route === "about" && <About />}
      </main>
      <Footer navigate={navigate} />
    </div>
  );
}
