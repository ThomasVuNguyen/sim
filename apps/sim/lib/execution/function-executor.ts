import { Script, createContext } from 'vm'
import { env } from '@/lib/core/config/env'
import { createLogger } from '@/lib/logs/console/logger'
import { generateRequestId } from '@/lib/core/utils/request'
import { CodeLanguage, DEFAULT_CODE_LANGUAGE, isValidCodeLanguage } from '@/lib/execution/languages'
import { DEFAULT_EXECUTION_TIMEOUT_MS } from '@/lib/execution/constants'

const logger = createLogger('FunctionExecutor')

/**
 * Input for function execution
 */
export interface FunctionExecutionInput {
  code: string
  params?: Record<string, any>
  timeout?: number
  language?: string
  envVars?: Record<string, string>
  blockData?: Record<string, any>
  blockNameMapping?: Record<string, string>
  workflowVariables?: Record<string, any>
  workflowId?: string
  isCustomTool?: boolean
}

/**
 * Output from function execution
 */
export interface FunctionExecutionOutput {
  success: boolean
  output: {
    result: any
    stdout: string
    executionTime: number
  }
  error?: string
}

/**
 * Check if E2B is enabled
 */
function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === '1'
}

/**
 * Get nested value from object using dot notation path
 */
function getNestedValue(obj: any, path: string): any {
  if (!obj || !path) return undefined
  return path.split('.').reduce((current, key) => {
    return current && typeof current === 'object' ? current[key] : undefined
  }, obj)
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Resolves workflow variables with <variable.name> syntax
 */
function resolveWorkflowVariables(
  code: string,
  workflowVariables: Record<string, any>,
  contextVariables: Record<string, any>
): string {
  let resolvedCode = code

  const variableMatches = resolvedCode.match(/<variable\.([^>]+)>/g) || []
  for (const match of variableMatches) {
    const variableName = match.slice('<variable.'.length, -1).trim()

    const foundVariable = Object.entries(workflowVariables).find(
      ([_, variable]) => (variable.name || '').replace(/\s+/g, '') === variableName
    )

    if (foundVariable) {
      const variable = foundVariable[1]
      let variableValue = variable.value

      if (variable.value !== undefined && variable.value !== null) {
        try {
          const type = variable.type === 'string' ? 'plain' : variable.type

          if (type === 'plain' && typeof variableValue === 'string') {
            // Use as-is for plain text
          } else if (type === 'number') {
            variableValue = Number(variableValue)
          } else if (type === 'boolean') {
            variableValue = variableValue === 'true' || variableValue === true
          } else if (type === 'json') {
            try {
              variableValue =
                typeof variableValue === 'string' ? JSON.parse(variableValue) : variableValue
            } catch {
              // Keep original value if JSON parsing fails
            }
          }
        } catch (error) {
          variableValue = variable.value
        }
      }

      const safeVarName = `__variable_${variableName.replace(/[^a-zA-Z0-9_]/g, '_')}`
      contextVariables[safeVarName] = variableValue
      resolvedCode = resolvedCode.replace(new RegExp(escapeRegExp(match), 'g'), safeVarName)
    } else {
      resolvedCode = resolvedCode.replace(new RegExp(escapeRegExp(match), 'g'), '')
    }
  }

  return resolvedCode
}

/**
 * Resolves environment variables with {{var_name}} syntax
 */
function resolveEnvironmentVariables(
  code: string,
  params: Record<string, any>,
  envVars: Record<string, string>,
  contextVariables: Record<string, any>
): string {
  let resolvedCode = code

  const envVarMatches = resolvedCode.match(/\{\{([^}]+)\}\}/g) || []
  for (const match of envVarMatches) {
    const varName = match.slice(2, -2).trim()
    const varValue = envVars[varName] || params[varName] || ''

    const safeVarName = `__var_${varName.replace(/[^a-zA-Z0-9_]/g, '_')}`
    contextVariables[safeVarName] = varValue
    resolvedCode = resolvedCode.replace(new RegExp(escapeRegExp(match), 'g'), safeVarName)
  }

  return resolvedCode
}

/**
 * Resolves tags with <tag_name> syntax (including nested paths)
 */
function resolveTagVariables(
  code: string,
  params: Record<string, any>,
  blockData: Record<string, any>,
  blockNameMapping: Record<string, string>,
  contextVariables: Record<string, any>
): string {
  let resolvedCode = code

  const tagMatches = resolvedCode.match(/<([a-zA-Z_][a-zA-Z0-9_.]*[a-zA-Z0-9_])>/g) || []

  for (const match of tagMatches) {
    const tagName = match.slice(1, -1).trim()

    let tagValue = getNestedValue(params, tagName) || getNestedValue(blockData, tagName) || ''

    if (!tagValue && tagName.includes('.')) {
      const parts = tagName.split('.')
      const blockName = parts[0]
      const path = parts.slice(1).join('.')

      const blockId = blockNameMapping[blockName.toLowerCase()]
      if (blockId) {
        tagValue = getNestedValue(blockData[blockId], path)
      }
    }

    if (tagValue !== undefined && tagValue !== '') {
      const safeVarName = `__tag_${tagName.replace(/[^a-zA-Z0-9_]/g, '_')}`
      contextVariables[safeVarName] = tagValue
      resolvedCode = resolvedCode.replace(new RegExp(escapeRegExp(match), 'g'), safeVarName)
    }
  }

  return resolvedCode
}

/**
 * Resolves all variable types in code
 */
function resolveCodeVariables(
  code: string,
  params: Record<string, any>,
  envVars: Record<string, string>,
  blockData: Record<string, any>,
  blockNameMapping: Record<string, string>,
  workflowVariables: Record<string, any>
): { resolvedCode: string; contextVariables: Record<string, any> } {
  let resolvedCode = code
  const contextVariables: Record<string, any> = {}

  resolvedCode = resolveWorkflowVariables(resolvedCode, workflowVariables, contextVariables)
  resolvedCode = resolveEnvironmentVariables(resolvedCode, params, envVars, contextVariables)
  resolvedCode = resolveTagVariables(
    resolvedCode,
    params,
    blockData,
    blockNameMapping,
    contextVariables
  )

  return { resolvedCode, contextVariables }
}

/**
 * Remove one trailing newline from stdout
 */
function cleanStdout(stdout: string): string {
  if (stdout.endsWith('\n')) {
    return stdout.slice(0, -1)
  }
  return stdout
}

/**
 * Execute function code directly without HTTP serialization.
 * This is the core execution logic used by both the API route and direct execution.
 */
export async function executeFunction(input: FunctionExecutionInput): Promise<FunctionExecutionOutput> {
  const requestId = generateRequestId()
  const startTime = Date.now()
  let stdout = ''
  let userCodeStartLine = 3
  let resolvedCode = ''

  try {
    const {
      code,
      params = {},
      timeout = DEFAULT_EXECUTION_TIMEOUT_MS,
      language = DEFAULT_CODE_LANGUAGE,
      envVars = {},
      blockData = {},
      blockNameMapping = {},
      workflowVariables = {},
      workflowId,
      isCustomTool = false,
    } = input

    const executionParams = { ...params }
    executionParams._context = undefined

    logger.info(`[${requestId}] Direct function execution`, {
      hasCode: !!code,
      paramsCount: Object.keys(executionParams).length,
      timeout,
      workflowId,
      isCustomTool,
    })

    // Resolve variables
    const codeResolution = resolveCodeVariables(
      code,
      executionParams,
      envVars,
      blockData,
      blockNameMapping,
      workflowVariables
    )
    resolvedCode = codeResolution.resolvedCode
    const contextVariables = codeResolution.contextVariables

    if (typeof resolvedCode !== 'string') {
      throw new Error('Internal error: code resolution produced invalid result')
    }

    const e2bEnabled = isTruthy(env.E2B_ENABLED)
    const lang = isValidCodeLanguage(language) ? language : DEFAULT_CODE_LANGUAGE

    // Check for imports (simplified check for direct execution)
    const hasImports = lang === CodeLanguage.JavaScript && 
      (/^import\s+/m.test(resolvedCode) || /require\s*\(\s*['"`]/.test(resolvedCode))

    // Python always requires E2B
    if (lang === CodeLanguage.Python && !e2bEnabled) {
      throw new Error(
        'Python execution requires E2B to be enabled. Please contact your administrator to enable E2B, or use JavaScript instead.'
      )
    }

    // JavaScript with imports requires E2B
    if (lang === CodeLanguage.JavaScript && hasImports && !e2bEnabled) {
      throw new Error(
        'JavaScript code with import statements requires E2B to be enabled. Please remove the import statements, or contact your administrator to enable E2B.'
      )
    }

    // For direct execution, we only support local VM execution (no E2B)
    // E2B execution still goes through the HTTP route
    if (e2bEnabled && !isCustomTool && (lang === CodeLanguage.Python || hasImports)) {
      // Fall back to HTTP route for E2B execution
      throw new Error('__USE_HTTP_ROUTE__')
    }

    // Local JavaScript execution
    const context: Record<string, any> = {
      console: {
        log: (...args: any[]) => {
          const output = args.map((arg) => 
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
          ).join(' ')
          stdout += output + '\n'
        },
        error: (...args: any[]) => {
          const output = args.map((arg) =>
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
          ).join(' ')
          stdout += `[ERROR] ${output}\n`
        },
        warn: (...args: any[]) => {
          const output = args.map((arg) =>
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
          ).join(' ')
          stdout += `[WARN] ${output}\n`
        },
      },
      fetch: globalThis.fetch,
      URL: globalThis.URL,
      URLSearchParams: globalThis.URLSearchParams,
      Headers: globalThis.Headers,
      Request: globalThis.Request,
      Response: globalThis.Response,
      FormData: globalThis.FormData,
      Blob: globalThis.Blob,
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      AbortController: globalThis.AbortController,
      AbortSignal: globalThis.AbortSignal,
      atob: globalThis.atob,
      btoa: globalThis.btoa,
      Buffer: Buffer,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      JSON: globalThis.JSON,
      Object: globalThis.Object,
      Array: globalThis.Array,
      String: globalThis.String,
      Number: globalThis.Number,
      Boolean: globalThis.Boolean,
      Date: globalThis.Date,
      Math: globalThis.Math,
      RegExp: globalThis.RegExp,
      Error: globalThis.Error,
      Promise: globalThis.Promise,
      Map: globalThis.Map,
      Set: globalThis.Set,
      parseInt: globalThis.parseInt,
      parseFloat: globalThis.parseFloat,
      isNaN: globalThis.isNaN,
      isFinite: globalThis.isFinite,
      encodeURIComponent: globalThis.encodeURIComponent,
      decodeURIComponent: globalThis.decodeURIComponent,
      encodeURI: globalThis.encodeURI,
      decodeURI: globalThis.decodeURI,
      ...contextVariables,
    }

    const vmContext = createContext(context)

    const wrapperLines = [
      ';(async () => {',
      '  try {',
      '    return await (async () => {',
    ]
    userCodeStartLine = wrapperLines.length

    const indentedCode = resolvedCode
      .split('\n')
      .map((line) => '      ' + line)
      .join('\n')

    const fullScript = [
      ...wrapperLines,
      indentedCode,
      '    })();',
      '  } catch (error) {',
      '    console.error(error);',
      '    throw error;',
      '  }',
      '})()',
    ].join('\n')

    let script: Script
    try {
      script = new Script(fullScript, {
        filename: 'user-function.js',
        lineOffset: 0,
        columnOffset: 0,
      })
    } catch (syntaxError: any) {
      if (syntaxError.name === 'SyntaxError') {
        logger.error(`[${requestId}] Syntax error creating script`, {
          error: syntaxError.message,
          resolvedCodePreview: resolvedCode?.substring(0, 200),
        })
      }
      throw syntaxError
    }

    const result = await script.runInContext(vmContext, {
      timeout,
      displayErrors: true,
    })

    const executionTime = Date.now() - startTime
    logger.info(`[${requestId}] Direct execution completed successfully`, {
      executionTime,
      hasResult: result !== undefined,
    })

    return {
      success: true,
      output: {
        result,
        stdout: cleanStdout(stdout),
        executionTime,
      },
    }
  } catch (error: any) {
    const executionTime = Date.now() - startTime

    // Special case: fall back to HTTP route for E2B
    if (error.message === '__USE_HTTP_ROUTE__') {
      throw error
    }

    logger.error(`[${requestId}] Direct function execution failed`, {
      error: error.message || 'Unknown error',
      stack: error.stack,
      executionTime,
    })

    return {
      success: false,
      output: {
        result: null,
        stdout: cleanStdout(stdout),
        executionTime,
      },
      error: error.message || 'Function execution failed',
    }
  }
}

