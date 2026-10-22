"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, LoaderCircle, TriangleAlert } from "lucide-react";
import { api } from "../../../lib/api-client.mjs";
import "../../../login/login.css";

export default function MetaCallbackPage() {
  const router = useRouter(), started = useRef(false);
  const [state, setState] = useState({ kind: "working", message: "กำลังตรวจสอบสิทธิ์จาก Facebook…" });
  useEffect(() => {
    if (started.current) return; started.current = true;
    const params = new URLSearchParams(window.location.search), code = params.get("code"), oauthState = params.get("state"), denied = params.get("error");
    window.history.replaceState({}, "", "/settings/meta/callback");
    if (denied || !code || !oauthState) { setState({ kind: "error", message: denied ? "ยกเลิกการเชื่อมต่อ Facebook แล้ว" : "ข้อมูลตอบกลับจาก Facebook ไม่ครบถ้วน" }); return; }
    void (async () => {
      try {
        const csrf = await api.request("/api/auth/csrf", { method: "POST" });
        const result = await api.request("/api/meta/connection/callback", { method: "POST", headers: { "X-CSRF-Token": csrf.csrfToken }, body: JSON.stringify({ code, state: oauthState }) });
        setState({ kind: "success", message: "ตรวจสอบสิทธิ์แล้ว กำลังเลือกเพจ…" });
        router.replace(`/sources?meta=${encodeURIComponent(result.id)}`);
      } catch (error) {
        if (error.status === 401) { router.replace("/login?next=%2Fsources"); return; }
        setState({ kind: "error", message: "ยืนยันสิทธิ์ไม่สำเร็จหรือรายการนี้ถูกใช้ไปแล้ว กรุณาเริ่มเชื่อมต่อใหม่" });
      }
    })();
  }, [router]);
  return <main className="rr-session-boundary">{state.kind === "working" ? <LoaderCircle className="meta-callback-spinner"/> : state.kind === "success" ? <CheckCircle2/> : <TriangleAlert/>}<h1>{state.kind === "error" ? "เชื่อมต่อไม่สำเร็จ" : "เชื่อมต่อ Facebook Page"}</h1><p>{state.message}</p>{state.kind === "error" ? <button type="button" onClick={() => router.replace("/sources")}>กลับไปหน้า Sources</button> : null}</main>;
}
