import React, { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF, Environment } from '@react-three/drei';

function Model({ url }) {
  const { scene } = useGLTF(url);
  return <primitive object={scene} scale={1.5} />;
}

export default function ThreeDViewer({ modelUrl }) {
  return (
    <Canvas camera={{ position: [2, 2, 2] }}>
      <ambientLight intensity={0.8} />
      <pointLight position={[5, 5, 5]} />
      <Suspense fallback={<div className="text-white">Loading 3D Model...</div>}>
        <Model url={modelUrl} />
        <OrbitControls />
        <Environment preset="city" />
      </Suspense>
    </Canvas>
  );
}