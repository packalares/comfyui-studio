import { Context } from 'koa';
import fs from 'fs-extra';
import path from 'path';
import { logger, i18nLogger } from '../../utils/logger';
import { DownloadController } from '../download/download.controller';
import { EssentialModel } from '../../types/models.types';
import { essentialModels } from '../essential-models.controller';
import { SystemController } from '../system/system.controller';
import { ModelInfoManager } from './info';
import { ModelInstallManager } from './install';
import { ModelDownloadManager } from './download';

// 下载任务接口
interface DownloadTask {
  overallProgress: number;
  currentModelIndex: number;
  currentModelProgress: number;
  currentModel: EssentialModel | null;
  completed: boolean;
  error: string | null;
  canceled: boolean;
  temporaryCanceled?: boolean;
  totalBytes: number;
  downloadedBytes: number;
  speed: number;
  startTime?: number;
  lastUpdateTime?: number;
  lastBytes?: number;
  lastLogTime?: number;
  status: 'downloading' | 'completed' | 'error';
  startBytes?: number;
}

export const isDev = process.env.NODE_ENV !== 'production';

// 记录下载任务状态
const downloadTasks = new Map<string, DownloadTask>();

// 添加响应类型接口
interface ProgressResponse {
  overallProgress: number;
  currentModelIndex: number;
  currentModelProgress: number;
  currentModel: EssentialModel | null;
  completed: boolean;
  error: string | null;
  totalBytes: number;
  downloadedBytes: number;
  speed: number;
  status: string;
}

export class ModelsController extends DownloadController {
  private modelInfoManager: ModelInfoManager;
  private modelInstallManager: ModelInstallManager;
  private modelDownloadManager: ModelDownloadManager;
  private comfyuiPath: string;
  private modelsDir: string;
  private systemController: SystemController;
  
  // 增加全局计数器跟踪进度事件
  private progressEventCounter = 0;
  
  constructor() {
    super(); // 调用父类构造函数
    
    // 初始化系统控制器
    this.systemController = new SystemController();
    
    // 初始化路径
    this.comfyuiPath = process.env.COMFYUI_PATH || 
      (isDev ? path.join(process.cwd(), 'comfyui') : '/root/ComfyUI');
    this.modelsDir = path.join(this.comfyuiPath, 'models');
    
    // 初始化各个管理器
    this.modelInfoManager = new ModelInfoManager(this.comfyuiPath);
    this.modelInstallManager = new ModelInstallManager(this.comfyuiPath);
    this.modelDownloadManager = new ModelDownloadManager(this.comfyuiPath);
    
    // 确保模型目录存在
    fs.ensureDirSync(this.modelsDir);

    // 启动时自动进行一次模型扫描
    this.initScan();
  }

  /**
   * 获取Hugging Face端点配置
   * 从系统控制器获取
   */
  private getHuggingFaceEndpoint(): string | undefined {
    // 优先使用环境变量
    if (process.env.HF_ENDPOINT) {
      return process.env.HF_ENDPOINT;
    }
    
    // 尝试从系统控制器的配置中获取
    if (this.systemController) {
      const envConfig = this.systemController.getEnvironmentConfig();
      return envConfig.HF_ENDPOINT;
    }
    
    return undefined;
  }

  // 初始化扫描方法
  private async initScan() {
    try {
      const logLang = i18nLogger.getLocale();
      i18nLogger.info('model.init_scan_start', { lng: logLang });
      
      // 延迟几秒后执行，以免影响应用启动速度
      setTimeout(async () => {
        // 刷新模型安装状态
        const updatedModels = await this.refreshInstalledStatus();
        
        // 更新本地缓存
        this.modelInfoManager.updateModelCache(updatedModels);
        
        const installedCount = updatedModels.filter(m => m.installed).length;
        i18nLogger.info('model.init_scan_completed', { count: installedCount, lng: logLang });
      }, 5000); // 延迟5秒执行，以免影响应用启动
    } catch (error) {
      const logLang = i18nLogger.getLocale();
      i18nLogger.error('model.init_scan_failed', { message: error instanceof Error ? error.message : String(error), lng: logLang });
    }
  }

  // 获取模型列表
  async getModelList(mode: 'cache' | 'local' | 'remote' = 'cache') {
    try {
      // 合并常规模型和基础模型列表
      const regularModels = await this.modelInfoManager.getModelList(mode);
      const essentialModelsList = this.modelInfoManager.convertEssentialModelsToModelInfo(essentialModels);
      
      // 使用Map进行去重，基础模型优先
      const modelMap = new Map<string, any>();
      
      // 先添加常规模型
      regularModels.forEach(model => {
        const key = model.filename || model.name || model.save_path;
        if (key) {
          modelMap.set(key, model);
        }
      });
      
      // 再添加基础模型（会覆盖同名的常规模型）
      essentialModelsList.forEach(model => {
        const key = model.filename || model.name || model.save_path;
        if (key) {
          modelMap.set(key, model);
        }
      });
      
      // 返回去重后的列表
      return Array.from(modelMap.values());
    } catch (error) {
      const logLang = i18nLogger.getLocale();
      i18nLogger.error('model.get_list_failed', { message: error instanceof Error ? error.message : String(error), lng: logLang });
      return [];
    }
  }

  // 添加一个新的API端点来处理模型名称下载请求
  async installModel(ctx: Context): Promise<void> {
    const { modelName } = ctx.params;
    const { source = 'hf' } = ctx.request.body as { source?: string };
    const logLang = (ctx.query.lang as string) || i18nLogger.getLocale();
    
    i18nLogger.info('model.install.request', { modelName, lng: logLang });
    
    if (!modelName) {
      ctx.status = 400;
      ctx.body = { 
        success: false,
        message: '模型名称不能为空' 
      };
      return;
    }
    
    try {
      // 1. 获取模型信息
      const modelInfo = await this.modelInfoManager.getModelInfo(modelName);
      if (!modelInfo) {
        throw new Error(`未找到模型 ${modelName} 的信息`);
      }
      
      // 2. 创建任务ID
      const taskId = this.createDownloadTask();
      
      // 3. 保存模型名称到任务ID的映射
      this.modelDownloads.set(modelName, taskId);
      
      // 4. 确定模型类型和保存路径
      const modelType = this.modelInstallManager.inferModelType(modelName);
      const modelDir = this.modelInstallManager.getModelSaveDir(modelType);
      const outputPath = path.join(this.comfyuiPath, modelDir, modelName);
      
      // 5. 构建下载URL
      let downloadUrl = this.modelDownloadManager.buildDownloadUrl(modelInfo, source);
      
      // 6. 检查HF_ENDPOINT配置，如果有则替换huggingface.co
      const hfEndpoint = this.getHuggingFaceEndpoint();
      downloadUrl = this.modelDownloadManager.processHfEndpoint(downloadUrl, hfEndpoint);
      
      i18nLogger.info('model.install.download_start', { url: downloadUrl, path: outputPath, lng: logLang });
      
      // 7. 异步启动下载过程
      this.downloadModelByName(modelName, downloadUrl, outputPath, taskId, source).catch(err => {
        i18nLogger.error('model.install.download_failed', { modelName, message: err instanceof Error ? err.message : String(err), lng: logLang });
      });
      
      // 8. 立即返回成功响应，让前端开始轮询
      ctx.body = {
        success: true,
        taskId: taskId,
        message: `开始下载模型 ${modelName}`
      };
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: `启动下载失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  // 获取下载进度
  getDownloadProgress(modelName: string): any {
    return this.modelDownloads.get(modelName) ? null : null;
  }

  // 重命名方法以避免与基类冲突
  async cancelModelDownload(modelName: string): Promise<void> {
    const taskId = this.modelDownloads.get(modelName);
    if (!taskId) {
      return;
    }
    
    // 调用基类的取消方法
    await this.cancelDownloadById(taskId);
    
    const logLang = i18nLogger.getLocale();
    i18nLogger.info('model.download.canceled', { modelName, lng: logLang });
  }
  
  // 为路由处理添加符合基类签名的方法
  async cancelDownload(ctx: Context): Promise<void> {
    const { modelName, taskId } = ctx.request.body as { modelName?: string; taskId?: string };
    
    // 获取客户端语言设置
    const locale = ctx.query.lang as string || this.getClientLocale(ctx) || 'en';
    
    // 优先使用 taskId，如果没有则使用 modelName（向后兼容）
    if (taskId) {
      // 使用基类的取消下载方法
      await this.cancelDownloadById(taskId);
      const message = this.translateMessage('models.download.cancel.success_task', { taskId }, locale);
      ctx.body = { success: true, message };
    } else if (modelName) {
      // 向后兼容：使用模型名称取消
      await this.cancelModelDownload(modelName);
      const message = this.translateMessage('models.download.cancel.success_model', { modelName }, locale);
      ctx.body = { success: true, message };
    } else {
      ctx.status = 400;
      const errorMessage = this.translateMessage('models.download.cancel.error_missing_params', {}, locale);
      ctx.body = { error: errorMessage };
      return;
    }
  }
  
  // 修改访问修饰符，与基类保持一致
  protected async cancelDownloadById(taskId: string): Promise<void> {
    if (!this.taskProgress.has(taskId)) {
      return;
    }
    
    const progress = this.taskProgress.get(taskId)!;
    progress.status = 'error';
    progress.error = '下载已取消';
    progress.canceled = true;
    
    if (progress.abortController) {
      progress.abortController.abort();
    }
    
    this.updateTaskProgress(taskId, progress);
  }

  // 翻译消息方法
  private translateMessage(key: string, options: Record<string, any> = {}, locale: string = 'en'): string {
    const translated = i18nLogger.translate(key, { lng: locale, ...options });
    
    // 检查是否返回了键名本身，这表示未找到翻译
    if (translated === key) {
      logger.warn(`Missing translation for key ${key} in locale ${locale}`);
      
      // 返回本地定义的备用文本
      const fallbackMap: Record<string, Record<string, string>> = {
        'zh': {
          'models.download.cancel.success_task': '已取消任务 {{taskId}}',
          'models.download.cancel.success_model': '已取消模型 {{modelName}} 的下载',
          'models.download.cancel.error_missing_params': '缺少模型名称或任务ID'
        },
        'en': {
          'models.download.cancel.success_task': 'Task {{taskId}} has been cancelled',
          'models.download.cancel.success_model': 'Download of model {{modelName}} has been cancelled',
          'models.download.cancel.error_missing_params': 'Missing model name or task ID'
        }
      };
      
      // 获取备用文本并替换变量
      let fallbackText = (fallbackMap[locale] && fallbackMap[locale][key]) || 
                        (fallbackMap['en'] && fallbackMap['en'][key]) || 
                        key;
      
      // 替换变量
      Object.keys(options).forEach(optionKey => {
        const placeholder = `{{${optionKey}}}`;
        fallbackText = fallbackText.replace(placeholder, options[optionKey]);
      });
      
      return fallbackText;
    }
    
    return translated;
  }

  // 在路由处理中添加获取下载进度的端点
  async getModelProgress(ctx: Context): Promise<void> {
    // 从查询参数获取语言设置
    const locale = ctx.query.lang as string || this.getClientLocale(ctx) || 'zh';
    
    // 注入语言参数到ctx中
    ctx.state.locale = locale;
    
    // 调用父类的 getProgress 方法
    await this.getProgress(ctx);
  }

  // 获取所有模型
  async getAllModels(ctx: Context): Promise<void> {
    // 实现获取所有模型的逻辑
    // 如果 getModels 方法有额外逻辑，应合并到这里
    ctx.body = {
      available: [
        { id: 'sd_1.5', name: 'SD 1.5 基础模型', size: '4.2 GB', downloaded: false },
        { id: 'sd_2.1', name: 'SD 2.1 基础模型', size: '5.3 GB', downloaded: false },
        { id: 'sdxl', name: 'SDXL 基础模型', size: '6.8 GB', downloaded: false },
        { id: 'controlnet', name: 'ControlNet', size: '3.5 GB', downloaded: true },
        { id: 'lora', name: 'LoRA 模型集合', size: '2.1 GB', downloaded: false }
      ],
      downloaded: [
        { id: 'controlnet', name: 'ControlNet', size: '3.5 GB', path: '/models/controlnet' }
      ]
    };
  }

  // 删除模型
  public async deleteModel(ctx: Context) {
    const { modelName } = ctx.request.body as { modelName?: string };
    
    if (!modelName) {
      ctx.status = 400;
      ctx.body = { error: '缺少模型名称' };
      return;
    }
    
    try {
      // 获取模型列表
      const models = await this.getModelList();
      
      // 使用安装管理器删除模型
      const result = await this.modelInstallManager.deleteModel(modelName, models);
      
      if (result.success) {
        // 更新模型缓存状态
        const updatedModels = await this.refreshInstalledStatus();
        this.modelInfoManager.updateModelCache(updatedModels);
        
        ctx.body = { 
          success: true,
          message: result.message
        };
      } else {
        ctx.status = 400;
        ctx.body = { 
          success: false,
          error: result.message
        };
      }
    } catch (error) {
      logger.error(`Delete model error: ${error instanceof Error ? error.message : String(error)}`);
      ctx.status = 500;
      ctx.body = { 
        error: `删除模型时出错: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }

  // 添加此方法作为 getModelList 的别名
  public async getModels(ctx: Context): Promise<void> {
    const models = await this.getModelList();
    ctx.body = models;
  }

  // 刷新模型列表的安装状态并检查完整性
  public async refreshInstalledStatus() {
    try {
      // 先获取模型列表
      const models = await this.getModelList();
      
      // 使用安装管理器刷新状态
      const updatedModels = await this.modelInstallManager.refreshInstalledStatus(models);
      
      return updatedModels;
    } catch (error) {
      const logLang = i18nLogger.getLocale();
      i18nLogger.error('model.refresh_status_failed', { message: error instanceof Error ? error.message : String(error), lng: logLang });
      return [];
    }
  }

  // API路由处理程序：扫描并更新模型安装状态
  public async scanModels(ctx: Context): Promise<void> {
    try {
      const logLang = (ctx.query.lang as string) || i18nLogger.getLocale();
      i18nLogger.info('model.scan.start', { lng: logLang });
      
      // 刷新模型安装状态
      const updatedModels = await this.refreshInstalledStatus();
      
      // 更新本地缓存
      this.modelInfoManager.updateModelCache(updatedModels);
      
      ctx.body = {
        success: true,
        count: updatedModels.filter(m => m.installed).length,
        models: updatedModels
      };
    } catch (error) {
      const logLang = (ctx.query.lang as string) || i18nLogger.getLocale();
      i18nLogger.error('model.scan.failed', { message: error instanceof Error ? error.message : String(error), lng: logLang });
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: `扫描模型失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  // 添加自定义模型下载方法
  async downloadCustomModel(ctx: Context): Promise<void> {
    const { hfUrl, modelDir, hfToken } = ctx.request.body as { hfUrl?: string; modelDir?: string; hfToken?: string };
    const logLang = (ctx.query.lang as string) || i18nLogger.getLocale();
    
    i18nLogger.info('model.custom.download_request', { url: hfUrl, dir: modelDir, lng: logLang });
    
    if (!hfUrl) {
      ctx.status = 400;
      ctx.body = { 
        success: false,
        message: 'Hugging Face URL不能为空' 
      };
      return;
    }
    
    if (!modelDir) {
      ctx.status = 400;
      ctx.body = { 
        success: false,
        message: '模型存放目录不能为空' 
      };
      return;
    }
    
    try {
      // 验证URL
      const validation = this.modelDownloadManager.validateHfUrl(hfUrl);
      if (!validation.isValid) {
        throw new Error(validation.error);
      }
      
      const fileName = validation.fileName;
      
      // 构建下载URL
      let downloadUrl = this.modelDownloadManager.buildResolveUrl(hfUrl);
      
      // 检查HF_ENDPOINT配置
      const hfEndpoint = this.getHuggingFaceEndpoint();
      downloadUrl = this.modelDownloadManager.processHfEndpoint(downloadUrl, hfEndpoint);
      
      // 创建任务ID
      const taskId = this.createDownloadTask();
      
      // 确定保存路径
      const saveDir = `models/${modelDir}`;
      const outputPath = path.join(this.comfyuiPath, saveDir, fileName);
      
      // 确保目录存在
      await this.modelDownloadManager.ensureSaveDirectory(saveDir);
      
      i18nLogger.info('model.custom.download_start', { url: downloadUrl, path: outputPath, lng: logLang });
      
      // 创建历史记录
      const historyItem = this.modelDownloadManager.createDownloadHistory(
        fileName, outputPath, downloadUrl, taskId
      );
      
      // 如果父类有添加历史记录的方法，使用它
      if (typeof this.addDownloadHistory === 'function') {
        this.addDownloadHistory(historyItem);
      }
      
      // 获取进度对象
      const progress = this.taskProgress.get(taskId);
      if (progress) {
        progress.abortController = new AbortController();
      }
      
      // Build auth headers if the caller passed a HuggingFace token (gated repos).
      const authHeaders: Record<string, string> | undefined =
        hfToken && /huggingface\.co/.test(downloadUrl)
          ? { Authorization: `Bearer ${hfToken}` }
          : undefined;

      // 启动异步下载过程
      this.modelDownloadManager.downloadModelAsync(
        downloadUrl,
        outputPath,
        taskId,
        fileName,
        progress,
        this.updateTaskProgress.bind(this),
        typeof this.updateDownloadHistory === 'function' ? this.updateDownloadHistory.bind(this) : undefined,
        this.downloadHistory,
        authHeaders
      ).then(() => {
        // On successful completion, rescan disk so the installed flag flips immediately —
        // otherwise the studio UI would keep reporting the model as missing until the next
        // manual /api/models/scan. No-op if the underlying download never actually wrote a file.
        this.refreshInstalledStatus().catch(() => { /* best effort */ });
      }).catch(err => {
        i18nLogger.error('model.custom.download_failed', { message: err instanceof Error ? err.message : String(err), lng: logLang });
      });
      
      // 返回成功响应和任务ID
      ctx.body = {
        success: true,
        taskId: taskId,
        message: `开始下载模型 ${fileName} 到 ${saveDir}`
      };
    } catch (error) {
      ctx.status = 500;
      ctx.body = {
        success: false,
        message: `启动下载失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
} 