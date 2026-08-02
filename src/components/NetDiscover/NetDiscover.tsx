import { useState, useCallback, useEffect, useRef } from "react";
import { Button, Stack, TextInput, Textarea, Select, Alert, Group, SegmentedControl, Text, Loader } from "@mantine/core";
import { useForm } from "@mantine/form";
import { CommandHelper } from "../../utils/CommandHelper";
import ConsoleWrapper from "../ConsoleWrapper/ConsoleWrapper";
import { SaveOutputToTextFile_v2 } from "../SaveOutputToFile/SaveOutputToTextFile";
import { checkAllCommandsAvailability } from "../../utils/CommandAvailability";
import InstallationModal from "../InstallationModal/InstallationModal";
import { RenderComponent } from "../UserGuide/UserGuide";

type ScanMode = "interface" | "range" | "list";

const NETDISCOVER_TABLE_HEADER = " IP            At MAC Address     Count     Len  MAC Vendor / Hostname";
const NETDISCOVER_TABLE_SEPARATOR =
    "-----------------------------------------------------------------------------";

interface FormValuesType {
    interface: string;
    ipRange: string;
    ipList: string;
}

const IP_RANGE_REGEX = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}\/(([0-9])|([1-2][0-9])|(3[0-2]))$/;
const SINGLE_IP_REGEX = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;
const INTERFACE_NAME_FORMAT_REGEX = /^[a-zA-Z][a-zA-Z0-9:_.-]{0,14}$/;

const parseInterfaceNames = (rawOutput: string): string[] => {
    const lines = rawOutput.split("\n");
    const names: string[] = [];
    for (const line of lines) {
        const match = line.match(/^\d+:\s+([^:@\s]+)/);
        if (match && match[1] && match[1] !== "lo") {
            names.push(match[1]);
        }
    }
    return Array.from(new Set(names));
};

interface ListEntry {
    ip: string;
    iface?: string;
}

const parseIPListEntries = (raw: string): ListEntry[] =>
    raw
        .split(/[\n,]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0)
        .map((token) => {
            const [ip, iface] = token.split(":").map((part) => part.trim());
            return { ip, iface: iface || undefined };
        });

const ipToInt = (ip: string): number => ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;

const intToIp = (n: number): string => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join(".");

const getSingleHostRange = (ip: string): string => {
    const n = ipToInt(ip);
    let prefix = 30;
    while (prefix >= 24) {
        const mask = (~0 << (32 - prefix)) >>> 0;
        const network = (n & mask) >>> 0;
        const broadcast = (network + (2 ** (32 - prefix) - 1)) >>> 0;
        if (n !== network && n !== broadcast) {
            return `${intToIp(network)}/${prefix}`;
        }
        prefix--;
    }
    return `${intToIp(n & 0xffffff00)}/24`;
};

const ToggleLink = ({ label, onClick }: { label: string; onClick: () => void }) => (
    <Text size="xs" color="blue" style={{ cursor: "pointer", width: "fit-content" }} onClick={onClick}>
        {label}
    </Text>
);

const getFriendlyErrorMessage = (rawMessage: string, mode: ScanMode): string => {
    const message = (rawMessage || "").toLowerCase();

    if (mode === "range" && (message.includes("unrecognized") || message.includes("invalid option"))) {
        return "That IP range wasn't accepted by NetDiscover. Please check the CIDR notation (e.g., 192.168.1.0/24).";
    }
    if (mode === "list" && (message.includes("unrecognized") || message.includes("invalid option"))) {
        return "One or more of your listed IP addresses wasn't accepted by NetDiscover. Please double-check the list and try again.";
    }
    if (mode === "interface" && (message.includes("no such device") || message.includes("interface"))) {
        return "Invalid input. Please use a valid network interface like eth0.";
    }
    if (message.includes("permission") || message.includes("not permitted") || message.includes("pkexec")) {
        return "Permission denied. Please confirm the authentication prompt to allow NetDiscover to run.";
    }
    if (message.includes("not found") || message.includes("command not found") || message.includes("enoent")) {
        return "NetDiscover could not be found. Please check that it is installed and try again.";
    }
    if (message.trim() === "") {
        return "Something went wrong while scanning. Please check your input and try again.";
    }
    return `Something went wrong: ${rawMessage}. Please check your input and try again.`;
};

function NetDiscover() {
    const [loading, setLoading] = useState(false);
    const [output, setOutput] = useState("");
    const [allowSave, setAllowSave] = useState(false);
    const [hasSaved, setHasSaved] = useState(false);
    const [opened, setOpened] = useState(false);
    const [loadingModal, setLoadingModal] = useState(true);
    const [scanMode, setScanMode] = useState<ScanMode>("interface");

    const [availableInterfaces, setAvailableInterfaces] = useState<string[]>([]);
    const [loadingInterfaces, setLoadingInterfaces] = useState(true);
    const [manualInterfaceEntry, setManualInterfaceEntry] = useState(false);
    const [listScanProgress, setListScanProgress] = useState<{ current: number; total: number } | null>(null);

    const processRef = useRef<any>(null);
    const cancelledRef = useRef(false);

    const form = useForm<FormValuesType>({
        initialValues: { interface: "", ipRange: "", ipList: "" },

        validate: (values) => ({
            interface:
                !values.interface
                    ? scanMode === "interface"
                        ? "Please select or enter a network interface (e.g., eth0)."
                        : null
                    : (() => {
                          if (availableInterfaces.length > 0) {
                              return availableInterfaces.includes(values.interface)
                                  ? null
                                  : `"${values.interface}" isn't one of your detected network interfaces (${availableInterfaces.join(
                                        ", "
                                    )}). Please choose one from the list.`;
                          }

                          return INTERFACE_NAME_FORMAT_REGEX.test(values.interface)
                              ? null
                              : "That doesn't look like a valid interface name (e.g., eth0, wlan0).";
                      })(),
            ipRange:
                scanMode === "range"
                    ? !values.ipRange
                        ? "Please enter an IP range."
                        : !IP_RANGE_REGEX.test(values.ipRange)
                        ? "Enter a valid IP range in CIDR notation (e.g., 192.168.1.0/24)."
                        : null
                    : null,
            ipList:
                scanMode === "list"
                    ? (() => {
                          const entries = parseIPListEntries(values.ipList);
                          if (entries.length === 0) {
                              return "Please enter at least one IP address (one per line or comma-separated, optionally as ip:interface).";
                          }
                          const badIps = entries.filter((e) => !SINGLE_IP_REGEX.test(e.ip)).map((e) => e.ip);
                          if (badIps.length > 0) {
                              return `These entries aren't valid IP addresses: ${badIps.join(", ")}`;
                          }
                          if (availableInterfaces.length > 0) {
                              const badIfaces = entries
                                  .filter((e) => e.iface && !availableInterfaces.includes(e.iface))
                                  .map((e) => `${e.ip}:${e.iface}`);
                              if (badIfaces.length > 0) {
                                  return `These entries specify an interface that wasn't detected (${availableInterfaces.join(
                                      ", "
                                  )}): ${badIfaces.join(", ")}`;
                              }
                          }
                          return null;
                      })()
                    : null,
        }),
    });

    useEffect(() => {
        checkAllCommandsAvailability(["netdiscover"])
            .then((available) => setOpened(!available))
            .finally(() => setLoadingModal(false));
    }, []);

    const fetchInterfaces = useCallback(async () => {
        setLoadingInterfaces(true);
        try {
            const result = await CommandHelper.runCommand("ip", ["-o", "link", "show"]);
            const names = parseInterfaceNames(result);
            setAvailableInterfaces(names);
            setManualInterfaceEntry(names.length === 0);
        } catch {
            
            setAvailableInterfaces([]);
            setManualInterfaceEntry(true);
        } finally {
            setLoadingInterfaces(false);
        }
    }, []);

    useEffect(() => {
        fetchInterfaces();
    }, [fetchInterfaces]);

    const handleProcessData = useCallback((data: string) => {
        const cleanedData = data.replace(
            /\x1B\[[0-9;]*[a-zA-Z]/g,
            ""
        );

        if (cleanedData.trim() === "") return;

        setOutput((prev) => prev + "\n" + cleanedData.trim());
    }, []);

    const handleProcessTermination = useCallback(({ code, signal }: { code: number; signal: number }) => {
        setOutput(
            (prev) =>
                prev + (signal === 2 || signal === 9 ? "\nScanning stopped manually." : `\nNetDiscover exited (code ${code}).`)
        );
        setLoading(false);
        setAllowSave(true);
        processRef.current = null;
    }, []);

    const handleSaveComplete = () => {
        setHasSaved(true);
        setAllowSave(false);
    };

    const buildArgs = (values: FormValuesType): string[] => {
        const ifaceArgs = values.interface ? ["-i", values.interface] : [];
        if (scanMode === "range") {
            return [...ifaceArgs, "-r", values.ipRange];
        }
        return ["-i", values.interface];
    };

    const killNetDiscover = async (): Promise<string> => {
        try {
            const result = await CommandHelper.runCommand("pkexec", ["pkill", "-9", "-x", "netdiscover"]);
            return result.trim();
        } catch (error: any) {
            return `Error running pkill: ${error?.message ?? error}`;
        }
    };

    const LIST_SCAN_TIMEOUT_MS = 15000;


    const runSingleTargetScan = (ip: string, interfaceName: string | undefined): Promise<void> => {
        const args = interfaceName
            ? ["-i", interfaceName, "-r", getSingleHostRange(ip)]
            : ["-r", getSingleHostRange(ip)];
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                resolve();
            };

            const timeoutId = setTimeout(async () => {
                await killNetDiscover();
                setOutput(
                    (prev) => prev + `\n(Moving to next target.)`
                );
                processRef.current = null;
                finish();
            }, LIST_SCAN_TIMEOUT_MS);
		
            CommandHelper.runCommandWithPkexec(
                "netdiscover",
                args,
                handleProcessData,
                () => {
                    processRef.current = null;
                    finish();
                }
            )
                .then((handle) => {
                    processRef.current = handle;
                })
                .catch((error: any) => {
                    setOutput((prev) => prev + `\nError scanning ${ip}: ${getFriendlyErrorMessage(error?.message, "list")}`);
                    finish();
                });
        });
    };

    const runListScanSequence = async (entries: ListEntry[], globalInterface: string) => {
        cancelledRef.current = false;
        for (let i = 0; i < entries.length; i++) {
            if (cancelledRef.current) break;
            const { ip, iface } = entries[i];
            const effectiveInterface = iface || globalInterface || undefined;
            setListScanProgress({ current: i + 1, total: entries.length });
            setOutput(
                (prev) =>
                    prev +
                    `\n\n--- Scanning ${ip}${effectiveInterface ? ` via ${effectiveInterface}` : ""} (${i + 1}/${entries.length}) ---\n` +
                    `${NETDISCOVER_TABLE_HEADER}\n${NETDISCOVER_TABLE_SEPARATOR}`
            );
            await runSingleTargetScan(ip, effectiveInterface);
        }
        setListScanProgress(null);
        setOutput(
            (prev) => prev + (cancelledRef.current ? "\n\nScanning stopped manually." : "\n\nFinished scanning all selected targets.")
        );
        setLoading(false);
        setAllowSave(true);
    };

    const onSubmit = async (values: FormValuesType) => {
        setLoading(true);
        setAllowSave(false);
        setOutput("");

        if (scanMode === "list") {
            runListScanSequence(parseIPListEntries(values.ipList), values.interface);
            return;
        }

        const args = buildArgs(values);

        processRef.current = await CommandHelper.runCommandWithPkexec(
            "netdiscover",
            args,
            handleProcessData,
            handleProcessTermination
        ).catch((error: any) => {
            setOutput(`Error: ${getFriendlyErrorMessage(error?.message, scanMode)}`);
            setLoading(false);
            setAllowSave(true);
        });
    };

    const cancelScan = async () => {
        if (scanMode === "list") cancelledRef.current = true;

        await killNetDiscover();
        setOutput((prev) => prev + `\nStop signal sent. Waiting for NetDiscover to exit...`);
        processRef.current = null;
    };

    const clearOutput = () => {
        setOutput("");
        setHasSaved(false);
        setAllowSave(false);
    };

    return (
        <>
            <RenderComponent
                title="NetDiscover Tool"
                description="NetDiscover identifies live hosts using ARP requests."
                steps={
                    "Step 1: Choose a scan mode either by network interface, IP range, or a specific list of IPs.\n" +
                    "Step 2: Select or enter the interface, IP range (CIDR), or list of target IPs.\n" +
                    "Step 3: Click 'Start Scan' to begin scanning the network.\n" +
                    "Step 4: Wait for hosts to appear in the output.\n" +
                    "Step 5: Click 'Stop Scanning' when you've collected enough information. "
                }
                tutorial="https://docs.google.com/document/d/1lREkzt3XvG6iIaxcpiMjSKxQUFGR8uKUg0PESz5DqfM/edit"
                sourceLink="https://tools.kali.org/information-gathering/netdiscover"
            >
                {!loadingModal && (
                    <InstallationModal
                        isOpen={opened}
                        setOpened={setOpened}
                        feature_description="NetDiscover"
                        dependencies={["netdiscover"]}
                    />
                )}
                <form onSubmit={form.onSubmit(onSubmit)}>
                    <Stack spacing="md">
                        <Stack spacing={4}>
                            {loadingInterfaces ? (
                                <Group spacing="xs">
                                    <Loader size="xs" />
                                    <Text size="sm" color="dimmed">
                                        Detecting available interfaces...
                                    </Text>
                                </Group>
                            ) : availableInterfaces.length > 0 && !manualInterfaceEntry ? (
                                <>
                                    <Select
                                        label="Network Interface"
                                        description={
                                            scanMode === "interface"
                                                ? "The local network adapter to scan on, e.g. eth0 or wlan0."
                                                : scanMode === "list"
                                                ? "Default adapter for targets that don't specify their own (see ip:interface syntax below). Recommended if your machine has more than one adapter."
                                                : "Optional, but strongly recommended if your machine has more than one adapter (e.g. a NAT and a host-only network in a VM) - without it, the scan may run on the wrong network and find nothing."
                                        }
                                        placeholder="Select an interface"
                                        data={availableInterfaces}
                                        searchable
                                        clearable={scanMode !== "interface"}
                                        required={scanMode === "interface"}
                                        {...form.getInputProps("interface")}
                                    />
                                    <ToggleLink
                                        label="Can't find your interface? Enter it manually."
                                        onClick={() => setManualInterfaceEntry(true)}
                                    />
                                </>
                            ) : (
                                <>
                                    <TextInput
                                        label="Network Interface"
                                        description={
                                            availableInterfaces.length > 0
                                                ? `Must exactly match one of your detected interfaces: ${availableInterfaces.join(
                                                      ", "
                                                  )}.`
                                                : "We couldn't detect your interfaces automatically, so this can only be checked for a valid format, not that it actually exists."
                                        }
                                        placeholder="e.g., eth0, wlan0"
                                        required={scanMode === "interface"}
                                        {...form.getInputProps("interface")}
                                    />
                                    {availableInterfaces.length > 0 ? (
                                        <ToggleLink
                                            label="Choose from detected interfaces instead."
                                            onClick={() => setManualInterfaceEntry(false)}
                                        />
                                    ) : (
                                        <ToggleLink label="Retry detection" onClick={fetchInterfaces} />
                                    )}
                                </>
                            )}
                        </Stack>

                        <Stack spacing={4}>
                            <SegmentedControl
                                value={scanMode}
                                onChange={(value) => setScanMode(value as ScanMode)}
                                disabled={loading}
                                data={[
                                    { label: "By Interface", value: "interface" },
                                    { label: "By IP Range", value: "range" },
                                    { label: "By IP List", value: "list" },
                                ]}
                            />
                            <Text size="xs" color="dimmed">
                                <b>Interface</b> scans your local network via ARP on a chosen adapter. <b>IP Range</b> scans a
                                CIDR block. <b>IP List</b> targets only the specific addresses you provide.
                            </Text>
                        </Stack>

                        {scanMode === "range" && (
                            <TextInput
                                label="IP Range (CIDR)"
                                description="A network block in CIDR notation, e.g. 192.168.1.0/24 scans addresses .0 through .255."
                                placeholder="e.g., 192.168.1.0/24"
                                required
                                {...form.getInputProps("ipRange")}
                            />
                        )}

                        {scanMode === "list" && (
                            <Textarea
                                label="IP List"
                                description="One or more specific IP addresses, separated by commas or new lines. Each is scanned one at a time. Add :interface to pin a target to a specific adapter (e.g. 192.168.1.10:eth0) if your targets live on different networks - otherwise the default interface above is used. Each IP address is scanned for 15 seconds before it moves on"
                                placeholder={"e.g.\n192.168.1.10\n192.168.1.25:eth1\n192.168.1.40"}
                                minRows={3}
                                required
                                {...form.getInputProps("ipList")}
                            />
                        )}

                        <Group>
                            <Button type="submit" disabled={loading}>
                                Start Scan
                            </Button>
                            <Button variant="outline" color="red" disabled={!loading} onClick={cancelScan}>
                                Stop Scanning
                            </Button>
                        </Group>

                        {loading && (
                            <Alert radius="md">
                                {scanMode === "range" && `Scanning IP range: ${form.values.ipRange}`}
                                {scanMode === "list" &&
                                    (listScanProgress
                                        ? `Scanning target ${listScanProgress.current} of ${listScanProgress.total}...`
                                        : "Starting scan...")}
                                {scanMode === "interface" && `Scanning on interface: ${form.values.interface}`}
                            </Alert>
                        )}

                        <ConsoleWrapper output={output} clearOutputCallback={clearOutput} />

                        {SaveOutputToTextFile_v2(output, allowSave, hasSaved, handleSaveComplete)}
                    </Stack>
                </form>
            </RenderComponent>
        </>
    );
}

export default NetDiscover;
