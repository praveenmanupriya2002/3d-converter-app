import React, { useState, useEffect, Suspense } from "react";
import axios from "axios";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, useGLTF, Environment } from "@react-three/drei";
import "./App.css";

// ================= MODEL COMPONENT =================
function Model({ url }) {
  const gltf = useGLTF(url);

  // 🔥 Prevent GPU memory leak + crash
  useEffect(() => {
    return () => {
      if (gltf?.scene) {
        gltf.scene.traverse((obj) => {
          if (obj.isMesh) {
            obj.geometry?.dispose();
            if (obj.material?.map) obj.material.map.dispose();
            obj.material?.dispose();
          }
        });
      }

      // clear loader cache when switching models
      useGLTF.clear(url);
    };
  }, [url]);

  return <primitive object={gltf.scene} scale={1.5} />;
}
// ================= 3D ERROR BOUNDARY =================
class ThreeErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.log("3D Viewer Crash:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="empty">
          <h3>⚠️ 3D Viewer crashed</h3>
          <p>Generate another model.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

// ================= CREDIT POPUP =================
const CreditPopup = ({ open, onClose, required = 30 }) => {
  const [redirecting, setRedirecting] = useState(false);

  const handleAddCredits = () => {
    setRedirecting(true);
    window.open("https://platform.tripo3d.ai/billing", "_blank");

    setTimeout(() => {
      setRedirecting(false);
      onClose();
    }, 3000);
  };

  if (!open) return null;

  return (
    <div className="popup-overlay">
      <div className="popup credit-popup">
        <div className="popup-header">
          <h3>⚠️ Insufficient Credits</h3>
        </div>

        <div className="popup-body">
          <div className="balance-info">
            <p className="required">
              Minimum required: <strong>{required} credits</strong> to generate a 3D model.
            </p>
          </div>

          <div className="action-buttons">
            <button
              className="btn primary"
              onClick={handleAddCredits}
              disabled={redirecting}
            >
              {redirecting ? "Redirecting..." : "💰 Add Credits on Tripo3D"}
            </button>

            <button className="btn secondary" onClick={onClose}>
              Cancel
            </button>
          </div>

          <p className="help-text">
            You will be redirected to Tripo3D billing page.
          </p>
        </div>
      </div>
    </div>
  );
};

// ================= NO IMAGE POPUP =================
const NoImagePopup = ({ open, onClose }) => {
  if (!open) return null;

  return (
    <div className="popup-overlay">
      <div className="popup">
        <h3>🖼 No Image Selected</h3>
        <p>Please upload an image before generating a 3D model.</p>
        <button className="btn secondary" onClick={onClose}>
              OK
        </button>
      </div>
    </div>
  );
};

// ================= MAIN APP =================
function App() {
  const [image, setImage] = useState(null);
  const [taskId, setTaskId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dark, setDark] = useState(true);
  const [env, setEnv] = useState("sunset");

  const [creditError, setCreditError] = useState(false);
  const [serverError, setServerError] = useState(false);
  const [noImageError, setNoImageError] = useState(false);

  

  // THEME
  useEffect(() => {
    document.body.className = dark ? "dark" : "light";
  }, [dark]);

  // HISTORY
  useEffect(() => {
  const saved = localStorage.getItem("models");

  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      setHistory(parsed || []);

      // FIX: auto select latest model
      if (parsed?.length > 0) {
        setSelected(parsed[0]);
      }
    } catch (e) {
      setHistory([]);
    }
  }
}, []);

useEffect(() => {
  try {
    localStorage.setItem("models", JSON.stringify(history));
  } catch (e) {
    console.log("localStorage error");
  }
}, [history]);

  // IMAGE UPLOAD
  const onImage = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImage(reader.result);
    reader.readAsDataURL(file);
  };

  // DELETE MODEL
  const deleteModel = (id) => {
    setHistory((prev) => prev.filter((item) => item.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  // GENERATE 3D
   const generate = async () => {
  if (!image) {
    setNoImageError(true);
    return;
  }

  if (loading) return;

  setLoading(true);
  setProgress(0);
  setServerError(false);
  setCreditError(false);

  try {
    if (typeof image !== "string" || image.length < 1000) {
      throw new Error("INVALID_IMAGE");
    }

    const res = await axios.post(
      "http://localhost:5001/api/generate-3d",
      { imageBase64: image },
      { timeout: 120000 } // ⬅ important fix
    );

    if (!res?.data?.taskId) {
      throw new Error("NO_TASK_ID");
    }

    setTaskId(res.data.taskId);
  } catch (err) {
  setLoading(false);

  const data = err?.response?.data;
  const status = err?.response?.status;

  const code = data?.code;
  const message = data?.message || "";

  console.log("API ERROR:", data);

  // ✅ CREDIT ERROR DETECTION (FIXED)
  const isCreditError =
    status === 402 ||
    code === 2010 ||
    message.toLowerCase().includes("credit");

  if (isCreditError) {
    setCreditError(true);   // 👈 THIS SHOWS YOUR POPUP
  } else {
    setServerError(true);
  }
}
};


  // POLLING
  useEffect(() => {
  if (!taskId) return;

  let done = false;

  const interval = setInterval(async () => {
    if (done) return;

    try {
      const res = await axios.get(
        `http://localhost:5001/api/task-status/${taskId}`
      );

      const { status, progress: real, modelUrl } = res.data;

      setProgress((p) => Math.min(real ?? p + 2, 95));

      if (status === "success" && modelUrl) {
        done = true;
        clearInterval(interval);

        setLoading(false);
        setProgress(100);

        const item = {
          id: Date.now(),
          image,
          modelUrl,
        };

        setHistory((prev) => {
          const exists = prev.find((x) => x.modelUrl === modelUrl);
          if (exists) return prev;
          return [item, ...prev];
        });

        setSelected(item);
      }

      if (status === "failed") {
        done = true;
        clearInterval(interval);
        setLoading(false);
        setServerError(true);
      }

    } catch (err) {
      setProgress((p) => p + 1);
    }
  }, 1200);

  return () => clearInterval(interval);
}, [taskId]);

  const download = (url) => {
  if (!url) return;

  const a = document.createElement("a");
  a.href = url;
  a.download = "model.glb";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  console.log("MODEL URL:", selected?.modelUrl);
};


  return (
    <div className="app">
      {/* CREDIT POPUP */}
      <CreditPopup
        open={creditError}
        onClose={() => setCreditError(false)}
        required={30}
      />

      <NoImagePopup open={noImageError} onClose={() => setNoImageError(false)} />

      {/* SERVER ERROR */}
      {serverError && (
        <div className="popup-overlay">
          <div className="popup">
            <h3>⚠️ Server Error</h3>
            <p>Something went wrong. Please try again later.</p>
            <button className="btn" onClick={() => setServerError(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      {/* TOP BAR */}
      <div className="topbar">
        <h2>⚡ 2D → 3D Converter</h2>

        <button className="btn" onClick={() => setDark(!dark)}>
          {dark ? "🌄 Light" : "🌇 Dark"}
        </button>
      </div>

      <div className="grid">
        {/* SIDEBAR */}
        <div className="sidebar">
          <h3>📁 Your Models</h3>

          {history.map((item) => (
            <div key={item.id} className="itemWrapper">
              <img
                src={item.image}
                className="thumb"
                onClick={() => setSelected(item)}
                alt="thumb"
              />
              <button className="deleteBtn" onClick={() => deleteModel(item.id)}>
                ✖
              </button>
            </div>
          ))}
        </div>

        {/* CENTER */}
        <div className="center">
          <label
            className="upload"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onImage(e.dataTransfer.files[0]);
            }}
          >
            <input
              type="file"
              hidden
              onChange={(e) => onImage(e.target.files[0])}
            />
            {!image ? (
              <p>📤 Click or Drag Image</p>
            ) : (
              <img src={image} className="preview" alt="preview" />
            )}
          </label>

          <button className="genBtn" disabled={loading} onClick={generate}>
            {loading ? "Generating..." : "🚀 Generate 3D"}
          </button>

          {loading && (
            <>
              <p>{Math.round(progress)}%</p>
              <div className="progress">
                <div className="progressFill" style={{ width: `${progress}%` }} />
              </div>
            </>
          )}
        </div>

        {/* RIGHT VIEWER */}
        <div className="right">

          {selected?.modelUrl ? (
            <>
              <Canvas key={selected.modelUrl} camera={{ position: [2, 2, 2] }}>
                <ambientLight intensity={0.8} />

                <Suspense fallback={null}>
                  <Model url={selected.modelUrl} />
                </Suspense>

                <OrbitControls />
                <Environment preset={env} />
              </Canvas>

              <button
                className="download"
                onClick={() => download(selected.modelUrl)}
              >
                📥 Download
              </button>
            </>
          ) : (
            <div className="empty">
              <h3>🎥 Model Viewer</h3>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

export default App;

