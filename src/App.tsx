import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./AuthContext";
import { Spinner } from "./components";

const Login = lazy(() => import("./pages/Login"));
const Admin = lazy(() => import("./pages/Admin"));
const Worker = lazy(() => import("./pages/Worker"));
const Track = lazy(() => import("./pages/Track"));
const Setup = lazy(() => import("./pages/Setup"));
const Assortment = lazy(() => import("./pages/Assortment"));

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<Track />} />
            <Route path="/login" element={<Login />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/worker" element={<Worker />} />
            <Route path="/track" element={<Track />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/assortment" element={<Assortment />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}
