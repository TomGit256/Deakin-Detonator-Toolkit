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

interface FormValuesType {
    interface: string;
    ipRange: string;
    ipList: string;
}

const IP_RANGE_REGEX =
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}\/(([0-9])|([1-2][0-9])|(3[0-2]))$/;

const SINGLE_IP_REGEX =
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;

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

const parseIPList = (raw: string): string[] =>
    raw
        .split(/[\n,]+/)
        .map((ip) => ip.trim())
        .filter((ip) => ip.length > 0);


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

    const processRef = useRef<any>(null);

    const form = useForm<FormValuesType>({
        initialValues: { interface: "", ipRange: "", ipList: "" },

        validate: (values) => ({
            interface:
                scanMode === "interface"
                    ? (() => {
                          if (!values.interface) {
                              return "Please select or enter a network interface (e.g., eth0).";
                          }

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
                      })()
                    : null,
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
                          const ips = parseIPList(values.ipList);
                          if (ips.length === 0) {
                              return "Please enter at least one IP address (one per line or comma-separated).";
                          }
                          const invalid = ips.filter((ip) => !SINGLE_IP_REGEX.test(ip));
                          if (invalid.length > 0) {
                              return `These entries aren't valid IP addresses: ${invalid.join(", ")}`;
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

        if (cleanedData.trim() !== "") {
            setOutput((prev) => prev + "\n" + cleanedData.trim());
        }
    }, []);

    const handleProcessTermination = useCallback(({ code, signal }: { code: number; signal: number }) => {
        setOutput(
            (prev) => prev + (signal === 2 ? "\nScanning stopped manually." : `\nNetDiscover exited (code ${code}).`)
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
        if (scanMode === "range") {
            return ["-r", values.ipRange];
        }
        if (scanMode === "list") {
            const ips = parseIPList(values.ipList);
            return ips.flatMap((ip) => ["-r", `${ip}/30`]);
        }
        return ["-i", values.interface];
    };

    const onSubmit = async (values: FormValuesType) => {
        setLoading(true);
        setAllowSave(false);
        setOutput("");

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
        if (processRef.current) {
            await CommandHelper.runCommand("pkexec", ["kill", "-9", processRef.current.pid])
                .then(() => setOutput((prev) => prev + `\nScanning manually stopped (PID: ${processRef.current.pid}).`))
                .catch((error: any) =>
                    setOutput((prev) => prev + `\nError stopping scan: ${getFriendlyErrorMessage(error?.message, scanMode)}`)
                )
                .finally(() => {
                    setLoading(false);
                    setAllowSave(true);
                    processRef.current = null;
                });
        } else {
            setOutput((prev) => prev + `\nNo active scanning process to stop.`);
            setLoading(false);
        }
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

                        {scanMode === "interface" && (
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
                                            description="The local network adapter to scan on, e.g. eth0 or wlan0."
                                            placeholder="Select an interface"
                                            data={availableInterfaces}
                                            searchable
                                            required
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
                                            required
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
                        )}

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
                                description="One or more specific IP addresses to scan, separated by commas or new lines, e.g. 192.168.1.10, 192.168.1.25. Only these hosts will be scanned."
                                placeholder={"e.g.\n192.168.1.10\n192.168.1.25\n192.168.1.40"}
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
                                    `Scanning ${parseIPList(form.values.ipList).length} selected target(s).`}
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
