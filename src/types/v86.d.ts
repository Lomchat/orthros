// src/types/v86.d.ts

declare module "v86" {
    /**
     * The type of disk/bios/state images
     */
    export type V86Image =
        | {
              url: string;
              async?: boolean;
              size?: number;
              use_parts?: boolean;
              fixed_chunk_size?: number;
          }
        | { buffer: ArrayBuffer };

    export enum LogLevel {
        LOG_ALL = -1,
        LOG_NONE = 0,
        LOG_OTHER = 0x000001,
        LOG_CPU = 0x000002,
        LOG_FPU = 0x000004,
        LOG_MEM = 0x000008,
        LOG_DMA = 0x000010,
        LOG_IO = 0x000020,
        LOG_PS2 = 0x000040,
        LOG_PIC = 0x000080,
        LOG_VGA = 0x000100,
        LOG_PIT = 0x000200,
        LOG_MOUSE = 0x000400,
        LOG_PCI = 0x000800,
        LOG_BIOS = 0x001000,
        LOG_FLOPPY = 0x002000,
        LOG_SERIAL = 0x004000,
        LOG_DISK = 0x008000,
        LOG_RTC = 0x010000,
        LOG_HPET = 0x020000,
        LOG_ACPI = 0x040000,
        LOG_APIC = 0x080000,
        LOG_NET = 0x100000,
        LOG_VIRTIO = 0x200000,
        LOG_9P = 0x400000,
        LOG_SB16 = 0x800000,
    }

    export enum BootOrder {
        AUTO = 0,
        CD_FLOPPY_HARDDISK = 0x213,
        CD_HARDDISK_FLOPLI_HARDDISK = 0x123,
        FLOPPY_CD_HARDDISK = 0x231,
        FLOPPY_HARDDISK_CD = 0x321,
        HARDDISK_CD_FLOPPY = 0x132,
    }

    export type Event =
        | "9p-attach"
        | "9p-read-end"
        | "9p-read-start"
        | "9p-write-end"
        | "download-error"
        | "download-progress"
        | "emulator-loaded"
        | "emulator-ready"
        | "emulator-started"
        | "emulator-stopped"
        | "eth-receive-end"
        | "eth-transmit-end"
        | "ide-read-end"
        | "ide-read-start"
        | "ide-write-end"
        | "mouse-enable"
        | "net0-send"
        | "screen-put-char"
        | "screen-set-size"
        | "serial0-output-byte"
        | "virtio-console0-output-bytes";

    /**
     * emulator instance constructor options.
     */
    export interface V86Options {
        wasm_fn?: (options: WebAssembly.Imports) => Promise<WebAssembly.Exports>;
        wasm_path?: string;
        memory_size?: number;
        vga_memory_size?: number;
        autostart?: boolean;
        disable_keyboard?: boolean;
        disable_mouse?: boolean;
        disable_speaker?: boolean;
        bios?: V86Image;
        vga_bios?: V86Image;
        hda?: V86Image;
        hdb?: V86Image;
        fda?: V86Image;
        fdb?: V86Image;
        cdrom?: V86Image;
        bzimage?: V86Image;
        cmdline?: string;
        initrd?: V86Image;
        bzimage_initrd_from_filesystem?: boolean;
        multiboot?: V86Image;
        initial_state?: V86Image;
        preserve_mac_from_state_image?: boolean;
        filesystem?: {
            baseurl?: string;
            basefs?: string;
            handle9p?: (reqbuf: Uint8Array, reply: (replybuf: Uint8Array) => void) => void;
            proxy_url?: string;
        };
        serial_container?: HTMLTextAreaElement;
        serial_container_xtermjs?: HTMLElement;
        screen_container?: HTMLElement | null;
        acpi?: boolean;
        log_level?: LogLevel;
        boot_order?: BootOrder;
        fastboot?: boolean;
        virtio_balloon?: boolean;
        virtio_console?: boolean;
        cpuid_level?: number;
        disable_jit?: boolean;
        network_relay_url?: string;
        net_device?: {
            type?: "ne2k" | "virtio";
            relay_url?: string;
            id?: number;
            router_mac?: string;
            router_ip?: string;
            vm_ip?: string;
            masquerade?: boolean;
            dns_method?: "static" | "doh";
            doh_server?: string;
            cors_proxy?: string;
            mtu?: number;
        };
    }

    /**
     * CPU interface for v86 emulator
     * Provides typed access to CPU registers and state
     */
    export interface IV86CPU {
        // General purpose registers: EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI
        reg32: Uint32Array | number[];
        // Instruction pointer (EIP) - array with single element
        instruction_pointer: number[] | Uint32Array;
        // Flags register (EFLAGS) - array with single element
        flags: number[] | Uint32Array;
        // Segment registers: ES=0, CS=1, SS=2, DS=3, FS=4, GS=5
        sreg?: number[] | Uint16Array;
        // Segment base addresses: ES=0, CS=1, SS=2, DS=3, FS=4, GS=5
        segment_offsets?: Int32Array;
        // Flag to prevent auto-increment of EIP after instruction
        is_jumping?: boolean;
        // Get segment base address (1 = CS, 2 = SS, etc.)
        get_seg_base?: (segmentIndex: number) => number;
        // I/O bus for port operations
        io?: any;
        // Devices (may contain io_bus)
        devices?: {
            io?: any;
        };
        // Alternative I/O bus location
        io_bus?: any;
    }

    /**
     * Emulator interface for v86
     * Provides typed access to emulator state and CPU
     */
    export interface IV86Emulator {
        // CPU object
        cpu?: IV86CPU;
        // Internal v86 state (may contain nested cpu)
        v86?: {
            cpu?: IV86CPU;
        };
        // Direct access to guest memory
        mem8: Uint8Array;
    }

    export class V86 {
        constructor(options: V86Options);
        v86: any; // Internal v86 state
        mem8: Uint8Array; // Direct access to guest memory
        cpu?: IV86CPU; // CPU object (typed)
        run(): void;
        stop(): Promise<void>;
        destroy(): Promise<void>;
        restart(): void;
        add_listener(event: Event, listener: Function): void;
        remove_listener(event: Event, listener: Function): void;
        restore_state(state: ArrayBuffer): Promise<void>;
        save_state(): Promise<ArrayBuffer>;
        get_instruction_counter(): number;
        is_running(): boolean;
        set_fda(image: V86Image): Promise<void>;
        eject_fda(): void;
        set_cdrom(image: V86Image): Promise<void>;
        eject_cdrom(): void;
        keyboard_send_scancodes(codes: number[]): void;
        keyboard_send_keys(codes: number[]): void;
        keyboard_send_text(string: string): void;
        screen_make_screenshot(): HTMLElement;
        screen_set_scale(sx: number, sy: number): void;
        screen_go_fullscreen(): void;
        lock_mouse(): void;
        mouse_set_enabled(enabled: boolean): void;
        keyboard_set_enabled(enabled: boolean): void;
        serial0_send(data: string): void;
        serial_send_bytes(serial: number, data: Uint8Array): void;
        create_file(file: string, data: Uint8Array): Promise<void>;
        read_file(file: string): Promise<Uint8Array>;
    }
}
