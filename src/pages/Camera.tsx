import { AppShell } from "../components/layout/AppShell";

// go2rtc стрим-сервері (ноутта істеп тұруы керек: camera-server\go2rtc.exe)
// Vercel-де VITE_CAMERA_SERVER айнымалысына туннельдің HTTPS адресін қойыңыз.
const STREAM_SERVER =
  import.meta.env.VITE_CAMERA_SERVER || "http://192.168.8.11:1984";

const CAMERAS: { name: string; id: string }[] = [
  { name: "Камера 1", id: "cam1" },
  { name: "Камера 2", id: "cam2" },
  { name: "Камера 3", id: "cam3" },
  { name: "Камера 4", id: "cam4" },
  { name: "Камера 5", id: "cam5" },
  { name: "Камера 6", id: "cam6" },
  { name: "Камера 7", id: "cam7" },
  { name: "Камера 8", id: "cam8" },
];

export default function Camera() {
  return (
    <AppShell title="Камера" subtitle="Цехтағы камералар">
      <div className="panel-card">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "16px",
          }}
        >
          {CAMERAS.map((cam) => (
            <div key={cam.id}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "6px",
                }}
              >
                <strong>{cam.name}</strong>
                <a
                  href={`${STREAM_SERVER}/stream.html?src=${cam.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Ашу ↗
                </a>
              </div>
              <div
                style={{
                  position: "relative",
                  width: "100%",
                  aspectRatio: "16 / 9",
                  borderRadius: "12px",
                  overflow: "hidden",
                  background: "#000",
                }}
              >
                <iframe
                  src={`${STREAM_SERVER}/stream.html?src=${cam.id}&mode=webrtc,mse`}
                  title={cam.name}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    border: "none",
                  }}
                  allow="fullscreen"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
