# ComfyUI Setup Guide

## Download

Download ComfyUI from the official releases:

- **Windows**: [ComfyUI_windows_portable_nvidia.7z](https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z)
- **All platforms**: [ComfyUI Releases](https://github.com/comfyanonymous/ComfyUI/releases)

Extract the archive and run `main.py` (or `comfy.exe` on Windows).

---

## Model Directory Structure

After downloading ComfyUI, place your models in the appropriate folders:

```
ComfyUI/
└── models/
    ├── checkpoints/    # Diffusion models (.safetensors, .ckpt)
    ├── vae/            # VAE files (.safetensors, .pt)
    ├── clip/           # CLIP models
    ├── loras/          # LoRA adapters
    ├── embeddings/     # Textual inversions
    └── upscale/        # Upscale models (ESRGAN, etc.)
```

### Quick Reference

| Model Type | Folder | Examples |
|------------|--------|----------|
| Diffusion (UNet) | `models/checkpoints/` | `*.safetensors`, `*.ckpt` |
| VAE | `models/vae/` | `*.safetensors`, `*.pt` |
| CLIP | `models/clip/` | `*.safetensors`, `*.gguf` |
| LoRA | `models/loras/` | `*.safetensors`, `*.pth` |
| Textual Inversion | `models/embeddings/` | `*.pt`, `*.bin` |

---

## Example Workflows

CharBrowser includes example workflow JSON files in `plans/comfyui_api/`:

| File | Model | Style | Status |
|------|-------|------|-------|
| `anima_api.json` | Anima | Anime/Illustration | ✅ Tested |
| `flux_api.json` | Flux | Flexible | ✅ Tested |
| `qwen_api.json` | Qwen Image | Photorealistic | ✅ Tested |
| `zit_api.json` | Z Image Turbo | Photorealistic | ✅ Tested |
| `flux_runpod_api.json` | Flux | Flexible | ⚠️ Untested (RunPod) |

### Model Requirements

Each workflow requires specific models installed in your ComfyUI:

**Anima** (`anima_api.json`):
- Diffusion: `anima*.safetensors` → `models/checkpoints/`
- VAE: `qwen_image_vae.safetensors` → `models/vae/`
- CLIP: `qwen*.safetensors` → `models/clip/`

**Flux** (`flux_api.json`):
- Diffusion: `flux*.gguf` → `models/unet/`
- VAE: `ae.safetensors` → `models/vae/`
- CLIP: `clip_l.safetensors`, `t5xxl_fp8_v4.safetensors` → `models/clip/`

**Qwen Image** (`qwen_api.json`):
- Diffusion: `qwen-image-*.gguf` → `models/unet/`
- VAE: built-in

**Z Image Turbo** (`zit_api.json`):
- Diffusion: `zimage*.safetensors` → `models/checkpoints/`
- VAE: built-in

To use these workflows:
1. Open CharBrowser Settings → ComfyUI
2. Paste the workflow JSON into the Workflow JSON field
3. Update the model filenames in the workflow to match your installed models

---

## Getting Workflow JSON

To create your own workflow:

1. Open ComfyUI in your browser
2. Build your generation pipeline using the node graph
3. Click **Save** (floppy disk icon) → **Export (API Format)**
4. Copy the exported JSON

### Required Placeholders

When editing a workflow for CharBrowser, add these placeholders where runtime values are needed:

- `%prompt%` - Positive prompt (from Visual Description or Description field)
- `%negative_prompt%` - Negative prompt (from settings)
- `%width%` - Output width (default: 800)
- `%height%` - Output height (default: 1200)

CharBrowser automatically replaces these placeholders with actual values at generation time.

---

## Configuring CharBrowser

1. Open CharBrowser Settings panel
2. Go to **ComfyUI** section
3. Enter your ComfyUI endpoint:
   - Local: `http://127.0.0.1:8188`
   - RunPod serverless: Enter your endpoint ID and API key
4. Paste your workflow JSON into the Workflow field
5. Click **Test Connection** to verify

---

## Model Sharing

If you already have models from another UI (Automatic1111, SD WebUI, etc.), you can share them without copying:

1. Find the `extra_model_paths.yaml.example` file in your ComfyUI folder
2. Rename it to `extra_model_paths.yaml`
3. Edit it to point to your existing model directories

Example for Automatic1111:
```yaml
extra_model_paths:
  sd_webui: "D:/stable-diffusion-webui/models/Stable-diffusion"
```

---

## Troubleshooting

### "Torch not compiled with CUDA enabled"
Uninstall and reinstall PyTorch with CUDA:
```bash
pip uninstall torch
pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu130
```

### Connection refused
- Make sure ComfyUI is running (`python main.py`)
- Check the endpoint URL in CharBrowser settings
- Verify firewall allows local connections

### Model not found
- Check the filename in the workflow matches exactly
- Ensure model is in the correct folder (checkpoints/vae/clip)

---

## Links

- ComfyUI GitHub: https://github.com/Comfy-Org/ComfyUI
- ComfyUI Documentation: https://docs.comfy.org
- Example Workflows: https://comfyanonymous.github.io/ComfyUI_examples/