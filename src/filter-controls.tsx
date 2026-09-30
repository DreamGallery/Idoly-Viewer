import {createContext,useContext,type ReactNode} from 'react';
const Context=createContext({value:'',onValueChange:(_v:string)=>{}});
export function Tabs({value,onValueChange,children}:{value:string;onValueChange:(v:string)=>void;children:ReactNode}){return <Context.Provider value={{value,onValueChange}}>{children}</Context.Provider>}
export function TabsList({children,className}:{children:ReactNode;className?:string;variant?:string}){return <div className={className} role="group" aria-label="组合筛选">{children}</div>}
export function TabsTrigger({value,children}:{value:string;children:ReactNode}){const c=useContext(Context);return <button aria-pressed={c.value===value} data-state={c.value===value?'active':''} onClick={()=>c.onValueChange(value)}>{children}</button>}
export function Select({value,onValueChange,children}:{value:string;onValueChange:(v:string)=>void;children:ReactNode}){return <select aria-label="翻译状态" value={value} onChange={e=>onValueChange(e.target.value)}>{children}</select>}
export function SelectTrigger(_props:Record<string,unknown>){return null}
export function SelectValue(){return null}
export function SelectContent({children}:{children:ReactNode}){return <>{children}</>}
export function SelectItem({value,children}:{value:string;children:ReactNode}){return <option value={value}>{children}</option>}
