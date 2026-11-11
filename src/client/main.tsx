import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Me, ModelList } from "../shared";
import { App } from "./App";
import "./styles.css";

function Root() {
  const [loaded, setLoaded] = useState<{ me: Me; modelList: ModelList } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const get = <T,>(path: string) =>
      fetch(path).then((res) => (res.ok ? (res.json() as Promise<T>) : Promise.reject(new Error(path))));
    Promise.all([get<Me>("/api/me"), get<ModelList>("/api/models")])
      .then(([me, modelList]) => setLoaded({ me, modelList }))
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">
        <p>
          You are not signed in.{" "}
          <button type="button" className="underline" onClick={() => location.reload()}>
            Reload to sign in
          </button>
        </p>
      </div>
    );
  }
  if (!loaded) return null;
  return <App me={loaded.me} modelList={loaded.modelList} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
