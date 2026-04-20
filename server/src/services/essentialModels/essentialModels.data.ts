// Hardcoded "essential" model catalog.
//
// Descriptions are English. URLs preserved verbatim so HF mirror / HF-hub
// fallback behaviour matches what existing installs expect.

import type { EssentialModel } from '../../contracts/models.contract.js';

export const essentialModels: EssentialModel[] = [
  {
    id: 'stable-diffusion-v1-5', name: 'stable-diffusion-v1-5', type: 'checkpoint', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors',
      hf: 'https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors',
    },
    dir: 'checkpoints', out: 'v1-5-pruned-emaonly.safetensors',
    description: 'Base SD model for general image generation',
  },
  {
    id: 'vae-ft-mse', name: 'VAE FT MSE', type: 'vae', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors',
      hf: 'https://huggingface.co/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors',
    },
    dir: 'vae', out: 'vae-ft-mse-840000-ema-pruned.safetensors',
    description: 'High-quality VAE for image reconstruction',
  },
  {
    id: 'taesd-decoder', name: 'TAESD Decoder', type: 'vae_approx', essential: true,
    url: {
      mirror: 'https://ghp.ci/https://raw.githubusercontent.com/madebyollin/taesd/main/taesd_decoder.pth',
      hf: 'https://raw.githubusercontent.com/madebyollin/taesd/main/taesd_decoder.pth',
    },
    dir: 'vae_approx', out: 'taesd_decoder.pth',
    description: 'Lightweight decoder for fast image preview',
  },
  {
    id: 'taesdxl-decoder', name: 'TAESDXL Decoder', type: 'vae_approx', essential: true,
    url: {
      mirror: 'https://ghp.ci/https://raw.githubusercontent.com/madebyollin/taesd/main/taesdxl_decoder.pth',
      hf: 'https://raw.githubusercontent.com/madebyollin/taesd/main/taesdxl_decoder.pth',
    },
    dir: 'vae_approx', out: 'taesdxl_decoder.pth',
    description: 'Lightweight SDXL preview decoder',
  },
  {
    id: 'taesd3-decoder', name: 'TAESD3 Decoder', type: 'vae_approx', essential: true,
    url: {
      mirror: 'https://ghp.ci/https://raw.githubusercontent.com/madebyollin/taesd/main/taesd3_decoder.pth',
      hf: 'https://raw.githubusercontent.com/madebyollin/taesd/main/taesd3_decoder.pth',
    },
    dir: 'vae_approx', out: 'taesd3_decoder.pth',
    description: 'Lightweight SD3 preview decoder',
  },
  {
    id: 'taef1-decoder', name: 'TAEF1 Decoder', type: 'vae_approx', essential: true,
    url: {
      mirror: 'https://ghp.ci/https://raw.githubusercontent.com/madebyollin/taesd/main/taef1_decoder.pth',
      hf: 'https://raw.githubusercontent.com/madebyollin/taesd/main/taef1_decoder.pth',
    },
    dir: 'vae_approx', out: 'taef1_decoder.pth',
    description: 'Lightweight Flux preview decoder',
  },
  {
    id: 'siax-upscaler', name: '4x NMKD-Siax upscaler', type: 'upscaler', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/gemasai/4x_NMKD-Siax_200k/resolve/main/4x_NMKD-Siax_200k.pth',
      hf: 'https://huggingface.co/gemasai/4x_NMKD-Siax_200k/resolve/main/4x_NMKD-Siax_200k.pth',
    },
    dir: 'upscale_models', out: '4x_NMKD-Siax_200k.pth',
    description: '4x high-quality image upscaler',
  },
  {
    id: 'remacri-upscaler', name: '4x Remacri upscaler', type: 'upscaler', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/uwg/upscaler/resolve/main/ESRGAN/4x_foolhardy_Remacri.pth',
      hf: 'https://huggingface.co/uwg/upscaler/resolve/main/ESRGAN/4x_foolhardy_Remacri.pth',
    },
    dir: 'upscale_models', out: '4x_foolhardy_Remacri.pth',
    description: '4x detail-preserving upscaler',
  },
  {
    id: 'nmkd-superscale', name: '8x NMKD-Superscale upscaler', type: 'upscaler', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/uwg/upscaler/resolve/main/ESRGAN/8x_NMKD-Superscale_150000_G.pth',
      hf: 'https://huggingface.co/uwg/upscaler/resolve/main/ESRGAN/8x_NMKD-Superscale_150000_G.pth',
    },
    dir: 'upscale_models', out: '8x_NMKD-Superscale_150000_G.pth',
    description: '8x large-ratio upscaler',
  },
  {
    id: 'easynegative', name: 'EasyNegative Embedding', type: 'embedding', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/datasets/gsdf/EasyNegative/resolve/main/EasyNegative.safetensors',
      hf: 'https://huggingface.co/datasets/gsdf/EasyNegative/resolve/main/EasyNegative.safetensors',
    },
    dir: 'embeddings', out: 'easynegative.safetensors',
    description: 'General-purpose negative prompt embedding',
  },
  {
    id: 'deepnegative', name: 'DeepNegative Embedding', type: 'embedding', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/lenML/DeepNegative/resolve/main/NG_DeepNegative_V1_75T.pt',
      hf: 'https://huggingface.co/lenML/DeepNegative/resolve/main/NG_DeepNegative_V1_75T.pt',
    },
    dir: 'embeddings', out: 'ng_deepnegative_v1_75t.pt',
    description: 'Deep-learning-tuned negative embedding for better image quality',
  },
  {
    id: 'mmdet-anime-face', name: 'MMDet anime-face detector', type: 'detector', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/dustysys/ddetailer/resolve/main/mmdet/bbox/mmdet_anime-face_yolov3.pth',
      hf: 'https://huggingface.co/dustysys/ddetailer/resolve/main/mmdet/bbox/mmdet_anime-face_yolov3.pth',
    },
    dir: 'mmdets/bbox', out: 'mmdet_anime-face_yolov3.pth',
    description: 'Anime-style face detection model',
  },
  {
    id: 'mmdet-anime-face-config', name: 'MMDet anime-face config', type: 'config', essential: true,
    url: {
      mirror: 'https://ghp.ci/https://raw.githubusercontent.com/Bing-su/dddetailer/master/config/mmdet_anime-face_yolov3.py',
      hf: 'https://raw.githubusercontent.com/Bing-su/dddetailer/master/config/mmdet_anime-face_yolov3.py',
    },
    dir: 'mmdets/bbox', out: 'mmdet_anime-face_yolov3.py',
    description: 'Config file for the anime-face detector',
  },
  {
    id: 'sam-vit-b', name: 'SAM ViT-B segmentation', type: 'segmentation', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/datasets/Gourieff/ReActor/resolve/main/models/sams/sam_vit_b_01ec64.pth',
      hf: 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/sams/sam_vit_b_01ec64.pth',
    },
    dir: 'sams', out: 'sam_vit_b_01ec64.pth',
    description: 'Segment Anything model for image segmentation',
  },
  {
    id: 'face-yolov8m', name: 'YOLOv8m face detector', type: 'detector', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/Bingsu/adetailer/resolve/main/face_yolov8m.pt',
      hf: 'https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt',
    },
    dir: 'ultralytics/bbox', out: 'face_yolov8m.pt',
    description: 'YOLOv8 model for face detection',
  },
  {
    id: 'hand-yolov8s', name: 'YOLOv8s hand detector', type: 'detector', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/Bingsu/adetailer/resolve/main/hand_yolov8s.pt',
      hf: 'https://huggingface.co/Bingsu/adetailer/resolve/main/hand_yolov8s.pt',
    },
    dir: 'ultralytics/bbox', out: 'hand_yolov8s.pt',
    description: 'YOLOv8 model for hand detection',
  },
  {
    id: 'person-yolov8m-seg', name: 'YOLOv8m person segmentation', type: 'segmentation', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/Bingsu/adetailer/resolve/main/person_yolov8m-seg.pt',
      hf: 'https://huggingface.co/Bingsu/adetailer/resolve/main/person_yolov8m-seg.pt',
    },
    dir: 'ultralytics/segm', out: 'person_yolov8m-seg.pt',
    description: 'YOLOv8 model for person detection and segmentation',
  },
  {
    id: 'gfpgan-v1.3', name: 'GFPGANv1.3 face restore', type: 'facerestore', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GFPGANv1.3.pth',
      hf: 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GFPGANv1.3.pth',
    },
    dir: 'facerestore_models', out: 'GFPGANv1.3.pth',
    description: 'Face restoration and detail enhancement model',
  },
  {
    id: 'gfpgan-v1.4', name: 'GFPGANv1.4 face restore', type: 'facerestore', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GFPGANv1.4.pth',
      hf: 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GFPGANv1.4.pth',
    },
    dir: 'facerestore_models', out: 'GFPGANv1.4.pth',
    description: 'Updated GFPGAN with improved face restoration',
  },
  {
    id: 'codeformer', name: 'CodeFormer face restore', type: 'facerestore', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/codeformer-v0.1.0.pth',
      hf: 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/codeformer-v0.1.0.pth',
    },
    dir: 'facerestore_models', out: 'codeformer-v0.1.0.pth',
    description: 'Identity-preserving face restoration model',
  },
  {
    id: 'gpen-bfr-512', name: 'GPEN-BFR-512 face restore', type: 'facerestore', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GPEN-BFR-512.onnx',
      hf: 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GPEN-BFR-512.onnx',
    },
    dir: 'facerestore_models', out: 'GPEN-BFR-512.onnx',
    description: 'Mid-resolution face restoration (ONNX)',
  },
  {
    id: 'gpen-bfr-1024', name: 'GPEN-BFR-1024 face restore', type: 'facerestore', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GPEN-BFR-1024.onnx',
      hf: 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GPEN-BFR-1024.onnx',
    },
    dir: 'facerestore_models', out: 'GPEN-BFR-1024.onnx',
    description: 'High-resolution face restoration (ONNX)',
  },
  {
    id: 'gpen-bfr-2048', name: 'GPEN-BFR-2048 face restore', type: 'facerestore', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GPEN-BFR-2048.onnx',
      hf: 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GPEN-BFR-2048.onnx',
    },
    dir: 'facerestore_models', out: 'GPEN-BFR-2048.onnx',
    description: 'Ultra-high-resolution face restoration (ONNX)',
  },
  {
    id: 'inswapper', name: 'InsightFace Swapper 128', type: 'faceswap', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/datasets/Gourieff/ReActor/resolve/main/models/inswapper_128.onnx',
      hf: 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/inswapper_128.onnx',
    },
    dir: 'insightface', out: 'inswapper_128.onnx',
    description: 'High-quality face-swap model',
  },
  {
    id: 'inswapper-fp16', name: 'InsightFace Swapper 128 FP16', type: 'faceswap', essential: true,
    url: {
      mirror: 'https://hf-mirror.com/datasets/Gourieff/ReActor/resolve/main/models/inswapper_128_fp16.onnx',
      hf: 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/inswapper_128_fp16.onnx',
    },
    dir: 'insightface', out: 'inswapper_128_fp16.onnx',
    description: 'Face-swap model (half-precision, low-VRAM)',
  },
];
