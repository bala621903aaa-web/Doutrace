export interface BuildRendererOptions {
  outDir?: string;
}

export interface BuiltRendererFiles {
  htmlPath: string;
  javascriptPath: string;
  stylesheetPath: string;
}

export function buildRenderer(options?: BuildRendererOptions): Promise<BuiltRendererFiles>;
