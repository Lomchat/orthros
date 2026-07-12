/**
 * DirectX Signature Validator
 * 
 * Validates that interface descriptors in ddraw.api.ts match
 * reference signatures from DirectX SDK header files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { InterfaceDescriptor } from '../api/types';

interface MethodSignature {
    name: string;
    cParams: number;  // Number of parameters in C++ (excluding this)
    vtableIndex: number;
    signature: string;
}

interface InterfaceSignature {
    interface: string;
    iid?: string;
    methods: MethodSignature[];
}

interface ValidationError {
    interface: string;
    method?: string;
    type: 'argCount_mismatch' | 'missing_method' | 'extra_method' | 'vtable_order' | 'iid_mismatch';
    message: string;
    expected?: any;
    actual?: any;
}

interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    warnings: ValidationError[];
    stats: {
        interfacesChecked: number;
        methodsChecked: number;
        errorsFound: number;
        warningsFound: number;
    };
}

export class DirectXSignatureValidator {
    private referenceSignatures: Map<string, InterfaceSignature> = new Map();
    private referenceDir: string;

    constructor(referenceDir: string = path.join(process.cwd(), 'tools/reference/directx')) {
        this.referenceDir = referenceDir;
        this.loadReferenceSignatures();
    }

    /**
     * Load reference signatures from .sig.json files
     */
    private loadReferenceSignatures(): void {
        const files = fs.readdirSync(this.referenceDir).filter(f => f.endsWith('.sig.json'));
        
        for (const file of files) {
            const filePath = path.join(this.referenceDir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content);
            
            if (Array.isArray(data.interfaces)) {
                for (const iface of data.interfaces) {
                    this.referenceSignatures.set(iface.interface, iface);
                }
            }
        }
    }

    /**
     * Extract interface descriptors from ddraw.api.ts using TypeScript AST
     */
    private extractInterfacesFromApiFile(filePath: string): Map<string, InterfaceDescriptor> {
        const content = fs.readFileSync(filePath, 'utf-8');
        const sourceFile = ts.createSourceFile(
            filePath,
            content,
            ts.ScriptTarget.Latest,
            true
        );
        
        const interfaces: Map<string, InterfaceDescriptor> = new Map();
        
        const visit = (node: ts.Node) => {
            // Look for: export const IDirect3D7: InterfaceDescriptor = { ... }
            if (ts.isVariableStatement(node)) {
                const declarations = node.declarationList.declarations;
                if (declarations.length > 0) {
                    const decl = declarations[0];
                    if (decl.name && ts.isIdentifier(decl.name)) {
                        const varName = decl.name.text;
                        const typeNode = decl.type;
                        
                        // Check if it's InterfaceDescriptor type
                        if (typeNode && typeNode.kind === ts.SyntaxKind.TypeReference) {
                            const typeRef = typeNode as ts.TypeReferenceNode;
                            if (typeRef.typeName && ts.isIdentifier(typeRef.typeName) && 
                                typeRef.typeName.text === 'InterfaceDescriptor') {
                                // Extract the object literal
                                if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
                                    const iface = this.extractInterfaceFromObject(decl.initializer, varName);
                                    if (iface) {
                                        interfaces.set(iface.name, iface);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            
            ts.forEachChild(node, visit);
        };
        
        visit(sourceFile);
        return interfaces;
    }
    
    /**
     * Extract interface from object literal expression
     */
    private extractInterfaceFromObject(
        obj: ts.ObjectLiteralExpression,
        varName: string
    ): InterfaceDescriptor | null {
        let name = '';
        let iid: string | undefined;
        const methods: Array<{ name: string; argCount: number }> = [];
        
        for (const prop of obj.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
                continue;
            }
            
            const propName = prop.name.text;
            
            if (propName === 'name' && ts.isStringLiteral(prop.initializer)) {
                name = prop.initializer.text;
            } else if (propName === 'iid' && ts.isStringLiteral(prop.initializer)) {
                iid = prop.initializer.text;
            } else if (propName === 'methods' && ts.isArrayLiteralExpression(prop.initializer)) {
                // Extract methods from array
                for (const element of prop.initializer.elements) {
                    if (ts.isCallExpression(element)) {
                        const methodInfo = this.extractMethodFromCall(element);
                        if (methodInfo) {
                            methods.push(methodInfo);
                        }
                    } else if (ts.isSpreadElement(element) && 
                               ts.isCallExpression(element.expression) &&
                               ts.isPropertyAccessExpression(element.expression.expression) &&
                               element.expression.expression.name.text === 'map') {
                        // Skip IUnknown methods spread: ...IUnknown.methods.map(...)
                        continue;
                    }
                }
            }
        }
        
        if (!name) {
            return null;
        }
        
        return {
            name,
            iid,
            methods: methods.map(m => ({
                name: m.name,
                params: Array(m.argCount).fill(0).map((_, i) => ({
                    name: i === 0 ? 'this' : `arg${i}`,
                    type: i === 0 ? 'ptr' : 'u32'
                })),
                returnType: 'u32',
                callingConvention: 'stdcall'
            }))
        } as InterfaceDescriptor;
    }
    
    /**
     * Extract method name and argCount from makeMethod call
     */
    private extractMethodFromCall(call: ts.CallExpression): { name: string; argCount: number } | null {
        if (!ts.isIdentifier(call.expression) || call.expression.text !== 'makeMethod') {
            return null;
        }
        
        if (call.arguments.length < 2) {
            return null;
        }
        
        const nameArg = call.arguments[0];
        const countArg = call.arguments[1];
        
        if (!ts.isStringLiteral(nameArg) || !ts.isNumericLiteral(countArg)) {
            return null;
        }
        
        return {
            name: nameArg.text,
            argCount: parseInt(countArg.text, 10)
        };
    }

    /**
     * Validate interface descriptor against reference signature
     */
    private validateInterface(
        descriptor: InterfaceDescriptor,
        reference: InterfaceSignature
    ): ValidationError[] {
        const errors: ValidationError[] = [];
        
        // Check IID
        if (reference.iid && descriptor.iid) {
            if (reference.iid.toLowerCase() !== descriptor.iid.toLowerCase()) {
                errors.push({
                    interface: descriptor.name,
                    type: 'iid_mismatch',
                    message: `IID mismatch for ${descriptor.name}`,
                    expected: reference.iid,
                    actual: descriptor.iid
                });
            }
        }
        
        // Build method maps
        const refMethods = new Map<string, MethodSignature>();
        for (const method of reference.methods) {
            refMethods.set(method.name, method);
        }

        // NOTE: `extractInterfacesFromApiFile()` returns only interface methods
        // (it skips the `...IUnknown.methods.map(...)` spread). So we must NOT
        // skip the first 3 methods here, otherwise we shift vtable indices.
        const descMethodsArray = descriptor.methods.map(m => ({
            name: m.name,
            argCount: m.params.length
        }));
        const descMethodsByName = new Map(descMethodsArray.map(m => [m.name, m] as const));
        
        // Check for missing methods
        for (const [name, refMethod] of refMethods) {
            if (!descMethodsByName.has(name)) {
                errors.push({
                    interface: descriptor.name,
                    method: name,
                    type: 'missing_method',
                    message: `Method ${name} is missing in ${descriptor.name}`,
                    expected: refMethod
                });
            }
        }
        
        // Check for extra methods (critical for vtable alignment)
        for (const descMethod of descMethodsArray) {
            const name = descMethod.name;
            if (!refMethods.has(name)) {
                errors.push({
                    interface: descriptor.name,
                    method: name,
                    type: 'extra_method',
                    message: `Method ${name} exists in ${descriptor.name} but not in reference (vtable misalignment!)`,
                    actual: descMethod
                });
            }
        }
        
        // Check argCount and vtable order for existing methods, by index.
        for (let i = 0; i < descMethodsArray.length; i++) {
            const descMethod = descMethodsArray[i];
            const refMethod = refMethods.get(descMethod.name);
            if (!refMethod) continue;

            // argCount should be cParams + 1 (this pointer)
            const expectedArgCount = refMethod.cParams + 1;
            if (descMethod.argCount !== expectedArgCount) {
                errors.push({
                    interface: descriptor.name,
                    method: descMethod.name,
                    type: 'argCount_mismatch',
                    message: `argCount mismatch for ${descriptor.name}::${descMethod.name}: expected ${expectedArgCount} (${refMethod.cParams} params + this), got ${descMethod.argCount}`,
                    expected: expectedArgCount,
                    actual: descMethod.argCount
                });
            }

            // vtable index mismatch
            if (refMethod.vtableIndex !== i) {
                errors.push({
                    interface: descriptor.name,
                    method: descMethod.name,
                    type: 'vtable_order',
                    message: `VTable order mismatch for ${descriptor.name}::${descMethod.name}: expected index ${refMethod.vtableIndex}, got ${i}`,
                    expected: refMethod.vtableIndex,
                    actual: i
                });
            }
        }
        
        return errors;
    }

    /**
     * Validate API file against reference signatures
     */
    validate(apiFilePath: string): ValidationResult {
        const errors: ValidationError[] = [];
        const warnings: ValidationError[] = [];
        
        const descriptors = this.extractInterfacesFromApiFile(apiFilePath);
        let interfacesChecked = 0;
        let methodsChecked = 0;
        
        for (const [name, descriptor] of descriptors) {
            const reference = this.referenceSignatures.get(name);
            
            if (!reference) {
                warnings.push({
                    interface: name,
                    type: 'missing_method',
                    message: `No reference signature found for ${name} - skipping validation`
                });
                continue;
            }
            
            interfacesChecked++;
            methodsChecked += descriptor.methods.length;
            
            const interfaceErrors = this.validateInterface(descriptor, reference);
            errors.push(...interfaceErrors);
        }
        
        return {
            valid: errors.length === 0,
            errors,
            warnings,
            stats: {
                interfacesChecked,
                methodsChecked,
                errorsFound: errors.length,
                warningsFound: warnings.length
            }
        };
    }
}

/**
 * Main validation function
 */
export function validateDirectXSignatures(
    apiFilePath: string = path.join(process.cwd(), 'src/worker/api/ddraw.api.ts'),
    referenceDir: string = path.join(process.cwd(), 'tools/reference/directx')
): ValidationResult {
    const validator = new DirectXSignatureValidator(referenceDir);
    return validator.validate(apiFilePath);
}
